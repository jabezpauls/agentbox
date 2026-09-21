import type { TerminalClientMessage, TerminalServerMessage } from "@workbench/shared";
import { wsUrl } from "../api/base.ts";

export interface TermSize {
  cols: number;
  rows: number;
}

/**
 * Where a pane's stream stands. `lost` is terminal for the automatic policy:
 * only an explicit retry (the cell's Reconnect button) leaves it.
 */
export type ConnState = "connecting" | "open" | "reconnecting" | "lost";

type DataCb = (bytes: Uint8Array) => void;
type SizeCb = (size: TermSize) => void;
type StateCb = (state: ConnState) => void;
type GoneCb = (reason: string) => void;

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 15_000;
export const MAX_ATTEMPTS = 8;
const MAX_QUEUED = 256;

/** Exponential backoff, in milliseconds, for the nth consecutive attempt. */
export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/**
 * The retry schedule, kept separate from the socket so it can be tested without
 * a WebSocket: each drop asks for the next delay, a successful open resets the
 * count, and after `MAX_ATTEMPTS` failures it gives up and hands the decision
 * back to the user.
 */
export class ReconnectPolicy {
  attempts = 0;

  /** Delay before the next attempt, or null when we should stop trying. */
  next(): number | null {
    this.attempts += 1;
    if (this.attempts > MAX_ATTEMPTS) return null;
    return backoffDelay(this.attempts);
  }

  reset(): void {
    this.attempts = 0;
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * One WebSocket to the bridge's terminal stream for a pane. The server pushes
 * raw ANSI bytes as binary frames (write them straight into xterm) and a couple
 * of JSON control records; the client sends input, resize, scroll and focus as
 * JSON text. herdr renders scrollback server-side, so this carries no history —
 * which is also why reconnecting is cheap: the bridge replays a full frame on
 * attach, so a dropped tunnel or a restarted bridge heals with no lost output.
 */
export class TerminalSocket {
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private closed = false;
  private size: TermSize;
  private readonly paneId: string;
  private readonly policy = new ReconnectPolicy();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dataCb: DataCb | null = null;
  private sizeCb: SizeCb | null = null;
  private stateCb: StateCb | null = null;
  private goneCb: GoneCb | null = null;
  private state: ConnState = "connecting";

  constructor(paneId: string, size: TermSize) {
    this.paneId = paneId;
    this.size = size;
    this.open();
  }

  private setState(state: ConnState): void {
    if (this.state === state) return;
    this.state = state;
    this.stateCb?.(state);
  }

  private open(): void {
    if (this.closed) return;
    const q = `?pane=${encodeURIComponent(this.paneId)}&cols=${this.size.cols}&rows=${this.size.rows}`;
    const ws = new WebSocket(wsUrl(`/ws/terminal${q}`));
    this.ws = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      if (this.closed) return;
      this.policy.reset();
      this.setState("open");
      // Re-state our geometry: on a reconnect the bridge has no memory of this
      // viewer, and the pane may have been resized by someone else meanwhile.
      ws.send(JSON.stringify({ type: "resize", ...this.size } satisfies TerminalClientMessage));
      for (const m of this.queue) ws.send(m);
      this.queue = [];
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.dataCb?.(new Uint8Array(ev.data));
        return;
      }
      let msg: TerminalServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as TerminalServerMessage;
      } catch {
        return;
      }
      if (msg.type === "size") this.sizeCb?.({ cols: msg.cols, rows: msg.rows });
      else if (msg.type === "closed") {
        // The pane itself is gone; retrying would only fail the same way.
        this.closed = true;
        this.setState("lost");
        this.goneCb?.(msg.reason);
      }
    };
    ws.onclose = () => {
      if (this.closed || this.ws !== ws) return;
      this.ws = null;
      this.schedule();
    };
    ws.onerror = () => {
      // `close` always follows; the reconnect is scheduled from there.
    };
  }

  private schedule(): void {
    const delay = this.policy.next();
    if (delay === null) {
      this.setState("lost");
      return;
    }
    this.setState("reconnecting");
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  /** Try again now, after the automatic policy gave up. */
  retry(): void {
    if (this.closed || this.ws) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.policy.reset();
    this.setState("connecting");
    this.open();
  }

  onData(cb: DataCb): void {
    this.dataCb = cb;
  }
  onSize(cb: SizeCb): void {
    this.sizeCb = cb;
  }
  /** Connection-state changes, for the cell's reconnect banner. */
  onState(cb: StateCb): void {
    this.stateCb = cb;
  }
  /** The pane ended server-side: no reconnect will help. */
  onGone(cb: GoneCb): void {
    this.goneCb = cb;
  }

  private send(msg: TerminalClientMessage): void {
    if (this.closed) return;
    const text = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
    // While reconnecting, hold a bounded amount of input: enough to cover a
    // blip without turning a long outage into unbounded memory.
    else if (this.queue.length < MAX_QUEUED) this.queue.push(text);
  }

  /** Send keystrokes (or a paste). Strings go as text; raw bytes as base64. */
  input(data: string | Uint8Array): void {
    if (typeof data === "string") this.send({ type: "input", text: data });
    else this.send({ type: "input", bytes: toBase64(data) });
  }

  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
    this.send({ type: "resize", cols, rows });
  }

  scroll(direction: "up" | "down", lines: number): void {
    this.send({ type: "scroll", direction, lines });
  }

  focus(): void {
    this.send({ type: "focus" });
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      this.ws?.close();
    } catch {
      // Already closing/closed; nothing to do.
    }
    this.ws = null;
  }
}
