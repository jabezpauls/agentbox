import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { TerminalClientMessage, TerminalMuxClientMessage, TerminalServerMessage } from "@workbench/shared";
import type { Attachment, TerminalStreams, Viewer } from "../herdr/terminal.js";
import { wsOriginGuard } from "../ws-origin.js";
import { heartbeat } from "../ws-heartbeat.js";

const PANE_RE = /^w\d+:p\d+$/;

/**
 * Above this many bytes still queued in a viewer's socket send buffer, we stop
 * feeding it and close the connection rather than let the buffer grow without
 * bound behind a viewer that cannot keep up (a backgrounded tab, a slow link).
 * The browser reconnects and is handed a fresh full frame, so nothing is lost
 * but the unbounded memory.
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** Panes one shared socket may view at once: far more than a screen shows. */
export const MAX_CHANNELS = 64;

/** True when a viewer's socket has buffered more than it should be allowed to. */
export function isBackpressured(bufferedAmount: number, limit = MAX_BUFFERED_BYTES): boolean {
  return bufferedAmount > limit;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
}

/** A shared-socket output frame: the channel, two bytes big-endian, then the pane's bytes. */
export function muxFrame(ch: number, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(2 + data.length);
  out.writeUInt16BE(ch, 0);
  data.copy(out, 2);
  return out;
}

/** Send `data` unless the socket has fallen too far behind, in which case end it. */
function sendOrShed(socket: WebSocket, data: Buffer): void {
  if (socket.readyState !== socket.OPEN) return;
  if (isBackpressured(socket.bufferedAmount)) {
    // Give up on a viewer that has fallen too far behind rather than buffer
    // unboundedly; the close triggers detach and, on reconnect, a fresh repaint.
    try {
      socket.close(1013, "viewer too slow");
    } catch {
      // socket already gone
    }
    return;
  }
  socket.send(data, { binary: true });
}

function sendJson(socket: WebSocket, m: object): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
}

/** Input, resize, scroll or focus, from either form of the socket. */
function control(a: Attachment, msg: TerminalClientMessage, size: { cols: number; rows: number }): void {
  switch (msg.type) {
    case "input":
      a.input(msg.text, msg.bytes);
      break;
    case "resize":
      a.resize(clamp(Number(msg.cols), 20, 500, size.cols), clamp(Number(msg.rows), 5, 200, size.rows));
      break;
    case "scroll":
      if (msg.direction === "up" || msg.direction === "down") a.scroll(msg.direction, Number(msg.lines));
      break;
    case "focus":
      a.focus();
      break;
    default:
      break;
  }
}

function parse<T>(raw: Buffer): T | null {
  try {
    return JSON.parse(raw.toString()) as T;
  } catch {
    return null;
  }
}

/** `?pane=`: the socket is one viewer of one pane, and closes when the pane does. */
function single(socket: WebSocket, streams: TerminalStreams, pane: string, cols: number, rows: number): void {
  const viewer: Viewer = {
    send: (data) => sendOrShed(socket, data),
    sendJson: (m) => sendJson(socket, m),
    close: (reason) => {
      try {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "closed", reason }));
          socket.close(1000);
        }
      } catch {
        // socket already gone
      }
    },
  };
  const attachment = streams.attach(pane, viewer, cols, rows);
  socket.on("message", (raw: Buffer) => {
    const msg = parse<TerminalClientMessage>(raw);
    if (msg) control(attachment, msg, { cols, rows });
  });
  socket.on("close", () => attachment.detach());
}

/**
 * No `?pane=`: one socket for every pane the page shows. Through the public
 * proxy each WebSocket handshake costs 0.4–1.4 s, and a browser opens a host's
 * WebSockets one at a time, so a socket per pane made the fourth pane of a tab
 * wait four handshakes. Here a pane is a channel, attached and detached by
 * message; the socket stays open with none, ready for the next.
 */
function shared(socket: WebSocket, streams: TerminalStreams): void {
  const channels = new Map<number, { attachment: Attachment; size: { cols: number; rows: number } }>();
  const notice = (ch: number, m: TerminalServerMessage) => sendJson(socket, { ...m, ch });

  const attach = (ch: number, pane: unknown, c: unknown, r: unknown): void => {
    if (channels.has(ch)) return;
    if (typeof pane !== "string" || !PANE_RE.test(pane)) return notice(ch, { type: "closed", reason: "invalid pane" });
    if (channels.size >= MAX_CHANNELS) return notice(ch, { type: "closed", reason: "too many panes on one socket" });
    const size = { cols: clamp(Number(c), 20, 500, 80), rows: clamp(Number(r), 5, 200, 24) };
    let live = true;
    const viewer: Viewer = {
      send: (data) => {
        if (live) sendOrShed(socket, muxFrame(ch, data));
      },
      sendJson: (m) => {
        if (live) notice(ch, m);
      },
      close: (reason) => {
        if (!live) return;
        live = false;
        channels.delete(ch);
        notice(ch, { type: "closed", reason });
      },
    };
    const attachment = streams.attach(pane, viewer, size.cols, size.rows);
    if (live) channels.set(ch, { attachment, size });
  };

  socket.on("message", (raw: Buffer) => {
    const msg = parse<TerminalMuxClientMessage>(raw);
    if (!msg) return;
    const ch = Number(msg.ch);
    if (!Number.isInteger(ch) || ch < 0 || ch > 0xffff) return;
    // The browser's own round-trip clock (WebSocket pings are invisible to
    // page script): answered at once, whatever the channel.
    if (msg.type === "ping") return sendJson(socket, { type: "pong", ch, t: Number(msg.t) || 0 });
    if (msg.type === "attach") return attach(ch, msg.pane, msg.cols, msg.rows);
    const c = channels.get(ch);
    if (!c) return;
    if (msg.type === "detach") {
      channels.delete(ch);
      c.attachment.detach();
      return;
    }
    if (msg.type === "resize") c.size = { cols: clamp(Number(msg.cols), 20, 500, c.size.cols), rows: clamp(Number(msg.rows), 5, 200, c.size.rows) };
    control(c.attachment, msg, c.size);
  });
  socket.on("close", () => {
    for (const c of channels.values()) c.attachment.detach();
    channels.clear();
  });
}

/**
 * `/ws/terminal?pane=<id>&cols=<n>&rows=<n>`: attach the socket as a viewer of a
 * pane stream. Server → binary ANSI frames and JSON `TerminalServerMessage`
 * notices; client → JSON `TerminalClientMessage` control frames.
 *
 * `/ws/terminal` alone: the shared form, many panes on one socket (see
 * `TerminalMuxClientMessage`). This is what the app uses.
 */
export function registerTerminalWs(app: FastifyInstance, streams: TerminalStreams): void {
  app.get<{ Querystring: { pane?: string; cols?: string; rows?: string } }>(
    "/ws/terminal",
    { websocket: true, onRequest: wsOriginGuard },
    (socket, req) => {
      const pane = req.query.pane;
      if (pane === undefined) {
        heartbeat(socket);
        shared(socket, streams);
        return;
      }
      if (typeof pane !== "string" || !PANE_RE.test(pane)) {
        socket.close(1008, "invalid pane");
        return;
      }
      heartbeat(socket);
      single(socket, streams, pane, clamp(Number(req.query.cols), 20, 500, 80), clamp(Number(req.query.rows), 5, 200, 24));
    },
  );
}
