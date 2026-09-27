import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { CliError, EXIT } from "./errors.js";
import type { BoxClient } from "./http.js";

/**
 * ttyd's WebSocket protocol, as ttyd 1.7.7 speaks it (src/protocol.c and
 * html/src/components/terminal/xterm/index.ts in its source):
 *
 * - the socket is `<base path>/ws` with the subprotocol `tty`;
 * - every frame the client sends is binary. The first is the JSON
 *   `{"AuthToken", "columns", "rows"}` — ttyd starts the command at that size
 *   only once it arrives (the token is ttyd's own basic-auth credential, empty
 *   here: the gate has already checked ours);
 * - after that, the first byte says what a frame is: `0` input (the rest is
 *   bytes for the program), `1` resize (`{"columns", "rows"}`), `2` pause and
 *   `3` resume (flow control: ttyd stops reading the program's output while
 *   paused);
 * - ttyd's frames are binary too: `0` output, `1` the window title, `2` the
 *   browser client's preferences (ignored here);
 * - when the program exits ttyd closes the socket, 1000 if it exited 0.
 *
 * `--check-origin` makes ttyd compare `Origin` with `Host`, so the socket is
 * opened with the box's own origin, exactly as the browser page would.
 */

export const CLIENT = { INPUT: 0x30, RESIZE: 0x31, PAUSE: 0x32, RESUME: 0x33 } as const;
export const SERVER = { OUTPUT: 0x30, TITLE: 0x31, PREFERENCES: 0x32 } as const;

export function handshakeFrame(columns: number, rows: number, authToken = ""): Buffer {
  return Buffer.from(JSON.stringify({ AuthToken: authToken, columns, rows }), "utf8");
}

export function inputFrame(data: Buffer | string): Buffer {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return Buffer.concat([Buffer.from([CLIENT.INPUT]), bytes]);
}

export function resizeFrame(columns: number, rows: number): Buffer {
  return Buffer.concat([Buffer.from([CLIENT.RESIZE]), Buffer.from(JSON.stringify({ columns, rows }), "utf8")]);
}

export const PAUSE_FRAME = Buffer.from([CLIENT.PAUSE]);
export const RESUME_FRAME = Buffer.from([CLIENT.RESUME]);

export type ServerFrame =
  | { kind: "output"; data: Buffer }
  | { kind: "title"; title: string }
  | { kind: "preferences"; preferences: unknown }
  | { kind: "unknown"; command: number };

export function parseServerFrame(frame: Buffer): ServerFrame {
  const command = frame[0];
  const rest = frame.subarray(1);
  switch (command) {
    case SERVER.OUTPUT:
      return { kind: "output", data: rest };
    case SERVER.TITLE:
      return { kind: "title", title: rest.toString("utf8") };
    case SERVER.PREFERENCES: {
      let preferences: unknown = null;
      try {
        preferences = JSON.parse(rest.toString("utf8"));
      } catch {
        // Only the browser client reads these.
      }
      return { kind: "preferences", preferences };
    }
    default:
      return { kind: "unknown", command: command ?? -1 };
  }
}

/** Why a terminal session ended. */
export type Ended =
  | { reason: "exited"; code: number; clean: boolean }
  | { reason: "detached" }
  | { reason: "error"; message: string };

/** WebSocket keepalive: Cloudflare drops a socket idle for 100 s. */
export const PING_MS = 25_000;

export interface TtydEvents {
  output: [Buffer];
  title: [string];
  open: [];
  close: [Ended];
}

/**
 * One ttyd session over the gate: open, send input and sizes, hear output,
 * and learn how it ended. Knows nothing about the local terminal.
 */
export class TtydSession extends EventEmitter<TtydEvents> {
  private ws: WebSocket | null = null;
  private pinger: NodeJS.Timeout | null = null;
  private ended = false;

  constructor(
    private readonly client: BoxClient,
    /** ttyd's base path: `/terminal` for herdr's TUI, `/shell` for bash. */
    readonly basePath: string,
  ) {
    super();
  }

  connect(columns: number, rows: number, opts: { pingMs?: number } = {}): void {
    const ws = new WebSocket(this.client.wsUrl(`${this.basePath}/ws`), ["tty"], {
      headers: { ...this.client.baseHeaders(), origin: this.client.origin },
      perMessageDeflate: false,
      handshakeTimeout: 30_000,
    });
    this.ws = ws;
    ws.binaryType = "nodebuffer";
    ws.on("open", () => {
      ws.send(handshakeFrame(columns, rows));
      this.pinger = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, opts.pingMs ?? PING_MS);
      this.pinger.unref();
      this.emit("open");
    });
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      const frame = isBinary ? data : Buffer.from(data);
      const parsed = parseServerFrame(frame);
      if (parsed.kind === "output") this.emit("output", parsed.data);
      else if (parsed.kind === "title") this.emit("title", parsed.title);
    });
    ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      const message =
        status === 401
          ? "the box did not accept this device's sign-in; run `agentbox login` again"
          : status === 403
            ? "the box refused the terminal (origin check); is the box's URL right?"
            : status === 404
              ? `this box has no ${this.basePath} terminal`
              : status === 502 || status === 503
                ? `the ${this.basePath} terminal is not running on the box`
                : `the box refused the terminal (HTTP ${status})`;
      this.finish({ reason: "error", message });
      ws.terminate();
    });
    ws.on("error", (err) => {
      this.finish({ reason: "error", message: `the connection failed: ${err.message}` });
    });
    ws.on("close", (code: number) => {
      // 1000: the program exited 0. ttyd reports any other exit as 1006,
      // which is also what a dropped connection looks like.
      this.finish({ reason: "exited", code, clean: code === 1000 });
    });
  }

  send(frame: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  input(data: Buffer): void {
    if (data.length) this.send(inputFrame(data));
  }

  resize(columns: number, rows: number): void {
    this.send(resizeFrame(columns, rows));
  }

  pause(): void {
    this.send(PAUSE_FRAME);
  }

  resume(): void {
    this.send(RESUME_FRAME);
  }

  /** Leave without ending the program (herdr keeps running; bash is hung up on). */
  detach(): void {
    this.finish({ reason: "detached" });
    this.ws?.close(1000);
  }

  /** Drop the connection without a word: the caller already knows why it is leaving. */
  dispose(): void {
    this.ended = true;
    if (this.pinger) clearInterval(this.pinger);
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
  }

  private finish(ended: Ended): void {
    if (this.ended) return;
    this.ended = true;
    if (this.pinger) clearInterval(this.pinger);
    this.emit("close", ended);
  }
}

/** The exit code a session's end maps to. */
export function exitCodeFor(ended: Ended): number {
  if (ended.reason === "detached") return EXIT.OK;
  if (ended.reason === "exited") return ended.clean ? EXIT.OK : EXIT.FAILURE;
  return EXIT.FAILURE;
}

export function describeEnd(ended: Ended): string | null {
  if (ended.reason === "error") return ended.message;
  if (ended.reason === "exited" && !ended.clean) return `the session ended (${ended.code === 1006 ? "the program exited with an error, or the connection dropped" : `code ${ended.code}`})`;
  return null;
}

export function notATerminal(): CliError {
  return new CliError("this needs a terminal (stdin is not a TTY)", EXIT.USAGE);
}
