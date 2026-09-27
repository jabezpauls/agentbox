import { WebSocket } from "ws";
import type { EditorClientMessage, EditorServerMessage } from "@workbench/shared";

/** Opens a file in the editor this extension runs in. */
export interface Opener {
  open(path: string, line?: number, column?: number): Promise<void>;
}

export interface ClientOptions {
  /** The bridge's editor channel, e.g. `ws://127.0.0.1:7800/ws/editor`. */
  url: string;
  /** This extension's version, sent in the hello. */
  version: string;
  opener: Opener;
  /** Whether this editor window has focus now. */
  focused: () => boolean;
  /** Reconnect backoff bounds. */
  minDelayMs?: number;
  maxDelayMs?: number;
  log?: (message: string) => void;
}

/**
 * The extension's end of the editor channel: a socket to the bridge, kept
 * open for as long as the editor runs (the bridge restarts on updates, so a
 * dropped socket is retried with a capped backoff). It says hello, reports
 * focus changes so the bridge knows which window a person is looking at, and
 * opens what it is sent, answering whether it could.
 */
export class BridgeClient {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delay: number;
  private stopped = false;

  constructor(private readonly opts: ClientOptions) {
    this.delay = opts.minDelayMs ?? 500;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }

  focusChanged(focused: boolean): void {
    this.send({ type: "focus", focused });
  }

  private send(m: EditorClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(m));
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url);
    this.socket = ws;
    ws.on("open", () => {
      this.delay = this.opts.minDelayMs ?? 500;
      this.opts.log?.(`connected to ${this.opts.url}`);
      this.send({ type: "hello", version: this.opts.version, focused: this.opts.focused() });
    });
    ws.on("message", (raw: Buffer) => void this.onMessage(raw));
    // A failed connection surfaces as an error and then a close; retry on the close.
    ws.on("error", () => {});
    ws.on("close", () => {
      if (this.socket === ws) this.socket = null;
      if (this.stopped) return;
      this.timer = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, this.opts.maxDelayMs ?? 10_000);
    });
  }

  private async onMessage(raw: Buffer): Promise<void> {
    let m: EditorServerMessage;
    try {
      m = JSON.parse(raw.toString()) as EditorServerMessage;
    } catch {
      return;
    }
    if (m.type !== "open" || typeof m.id !== "string" || typeof m.path !== "string") return;
    try {
      await this.opts.opener.open(m.path, m.line, m.column);
      this.send({ type: "opened", id: m.id, ok: true });
    } catch (err) {
      this.send({ type: "opened", id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
