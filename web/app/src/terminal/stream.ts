import type { TerminalClientMessage, TerminalServerMessage } from "@workbench/shared";
import { wsUrl } from "../api/base.ts";

export interface TermSize {
  cols: number;
  rows: number;
}

type DataCb = (bytes: Uint8Array) => void;
type SizeCb = (size: TermSize) => void;
type CloseCb = (reason: string) => void;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * One WebSocket to the bridge's terminal stream for a pane. The server pushes
 * raw ANSI bytes as binary frames (write them straight into xterm) and a couple
 * of JSON control records; the client sends input, resize, scroll and focus as
 * JSON text. herdr renders scrollback server-side, so this carries no history.
 */
export class TerminalSocket {
  private ws: WebSocket;
  private queue: string[] = [];
  private closed = false;
  private dataCb: DataCb | null = null;
  private sizeCb: SizeCb | null = null;
  private closeCb: CloseCb | null = null;

  constructor(paneId: string, size: TermSize) {
    const q = `?pane=${encodeURIComponent(paneId)}&cols=${size.cols}&rows=${size.rows}`;
    this.ws = new WebSocket(wsUrl(`/ws/terminal${q}`));
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      for (const m of this.queue) this.ws.send(m);
      this.queue = [];
    };
    this.ws.onmessage = (ev) => {
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
      else if (msg.type === "closed") this.closeCb?.(msg.reason);
    };
    this.ws.onclose = () => {
      if (!this.closed) this.closeCb?.("disconnected");
    };
  }

  onData(cb: DataCb): void {
    this.dataCb = cb;
  }
  onSize(cb: SizeCb): void {
    this.sizeCb = cb;
  }
  onClose(cb: CloseCb): void {
    this.closeCb = cb;
  }

  private send(msg: TerminalClientMessage): void {
    if (this.closed) return;
    const text = JSON.stringify(msg);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
    else this.queue.push(text);
  }

  /** Send keystrokes (or a paste). Strings go as text; raw bytes as base64. */
  input(data: string | Uint8Array): void {
    if (typeof data === "string") this.send({ type: "input", text: data });
    else this.send({ type: "input", bytes: toBase64(data) });
  }

  resize(cols: number, rows: number): void {
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
    try {
      this.ws.close();
    } catch {
      // Already closing/closed; nothing to do.
    }
  }
}
