import type { TerminalClientMessage, TerminalMuxClientMessage, TerminalMuxServerMessage } from "@workbench/shared";
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

/** What the shared socket needs from each pane on it. */
interface Channel {
  /** The shared socket is open: attach, and send what was held. */
  opened(): void;
  /** The shared socket dropped, is retrying, or gave up. */
  dropped(state: ConnState): void;
  data(bytes: Uint8Array): void;
  notice(msg: TerminalMuxServerMessage): void;
}

/**
 * The one WebSocket every terminal on the page shares. Through the public
 * proxy a WebSocket handshake costs 0.4–1.4 s (a fresh TCP and TLS connection
 * each time), and a browser opens a host's WebSockets one at a time: with a
 * socket per pane, the fourth pane of a tab waited out four handshakes, and
 * every tab switch paid one more. Now the handshake is paid once, early (see
 * `prewarmTerminalSocket`), and a pane attaches as a channel on a socket that
 * is already open. The bridge replays a full frame on every attach, so a
 * reconnect re-attaches every channel and heals with no lost output.
 */
class SharedSocket {
  private ws: WebSocket | null = null;
  private open = false;
  private readonly channels = new Map<number, Channel>();
  private nextCh = 1;
  private readonly policy = new ReconnectPolicy();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private gaveUp = false;

  /** Open the socket now unless it is open, opening, or waiting to retry. */
  ensure(): void {
    if (this.ws || this.timer || this.gaveUp) return;
    this.connect();
  }

  add(channel: Channel): number {
    let ch = this.nextCh;
    while (this.channels.has(ch)) ch = (ch % 0xffff) + 1;
    this.nextCh = (ch % 0xffff) + 1;
    this.channels.set(ch, channel);
    // A new pane after the policy gave up is a fresh reason to try again.
    if (this.gaveUp) this.retry();
    else if (this.open) queueMicrotask(() => this.channels.get(ch) === channel && channel.opened());
    else this.ensure();
    return ch;
  }

  remove(ch: number): void {
    if (!this.channels.delete(ch)) return;
    this.send({ ch, type: "detach" });
  }

  /** Send now if open; false if the caller should hold the message. */
  send(msg: TerminalMuxClientMessage): boolean {
    if (!this.open || !this.ws) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Try again now, after the automatic policy gave up. */
  retry(): void {
    if (this.ws) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.gaveUp = false;
    this.policy.reset();
    for (const c of this.channels.values()) c.dropped("connecting");
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(wsUrl("/ws/terminal"));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.open = true;
      this.policy.reset();
      for (const c of [...this.channels.values()]) c.opened();
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        if (ev.data.byteLength < 2) return;
        const ch = new DataView(ev.data).getUint16(0);
        this.channels.get(ch)?.data(new Uint8Array(ev.data, 2));
        return;
      }
      let msg: TerminalMuxServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as TerminalMuxServerMessage;
      } catch {
        return;
      }
      this.channels.get(msg.ch)?.notice(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.open = false;
      // With no pane on it, wait for the next one to reopen; otherwise retry.
      if (this.channels.size === 0) return;
      const delay = this.policy.next();
      if (delay === null) {
        this.gaveUp = true;
        for (const c of this.channels.values()) c.dropped("lost");
        return;
      }
      for (const c of this.channels.values()) c.dropped("reconnecting");
      this.timer = setTimeout(() => {
        this.timer = null;
        this.connect();
      }, delay);
    };
    ws.onerror = () => {
      // `close` always follows; the reconnect is scheduled from there.
    };
  }
}

let shared: SharedSocket | null = null;
function sharedSocket(): SharedSocket {
  return (shared ??= new SharedSocket());
}

/** Start the shared terminal socket's handshake now, ahead of the first pane. */
export function prewarmTerminalSocket(): void {
  if (typeof WebSocket === "undefined") return;
  sharedSocket().ensure();
}

/** Forget the shared socket (tests only): the next terminal starts afresh. */
export function resetTerminalSocketForTests(): void {
  shared = null;
}

/**
 * One pane's terminal stream: a channel on the shared socket. The server
 * pushes raw ANSI bytes (write them straight into xterm) and a couple of JSON
 * notices; the client sends input, resize, scroll and focus. herdr renders
 * scrollback server-side, so this carries no history — which is also why
 * reconnecting is cheap.
 */
export class TerminalSocket {
  private queue: TerminalClientMessage[] = [];
  private closed = false;
  private attached = false;
  private size: TermSize;
  private readonly paneId: string;
  private readonly mux: SharedSocket;
  private readonly ch: number;
  private dataCb: DataCb | null = null;
  private sizeCb: SizeCb | null = null;
  private stateCb: StateCb | null = null;
  private goneCb: GoneCb | null = null;
  private state: ConnState = "connecting";

  constructor(paneId: string, size: TermSize) {
    this.paneId = paneId;
    this.size = size;
    this.mux = sharedSocket();
    this.ch = this.mux.add({
      opened: () => this.opened(),
      dropped: (state) => {
        this.attached = false;
        if (!this.closed) this.setState(state);
      },
      data: (bytes) => this.dataCb?.(bytes),
      notice: (msg) => {
        if (msg.type === "size") this.sizeCb?.({ cols: msg.cols, rows: msg.rows });
        else if (msg.type === "closed") {
          // The pane itself is gone; retrying would only fail the same way.
          this.closed = true;
          this.mux.remove(this.ch);
          this.setState("lost");
          this.goneCb?.(msg.reason);
        }
      },
    });
  }

  private opened(): void {
    if (this.closed) return;
    // Name the pane at our size: on a reconnect the bridge has no memory of
    // this viewer, and the pane may have been resized by someone else meanwhile.
    this.mux.send({ ch: this.ch, type: "attach", pane: this.paneId, ...this.size });
    this.attached = true;
    this.setState("open");
    for (const m of this.queue) this.mux.send({ ...m, ch: this.ch });
    this.queue = [];
  }

  private setState(state: ConnState): void {
    if (this.state === state) return;
    this.state = state;
    this.stateCb?.(state);
  }

  /** Try again now, after the automatic policy gave up. */
  retry(): void {
    if (this.closed) return;
    this.mux.retry();
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
    if (this.attached && this.mux.send({ ...msg, ch: this.ch })) return;
    // While reconnecting, hold a bounded amount of input: enough to cover a
    // blip without turning a long outage into unbounded memory.
    if (this.queue.length < MAX_QUEUED) this.queue.push(msg);
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
    if (this.closed) return;
    this.closed = true;
    this.mux.remove(this.ch);
  }
}
