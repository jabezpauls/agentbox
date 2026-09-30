import type { FastifyInstance } from "fastify";
import type { TerminalClientMessage } from "@workbench/shared";
import type { TerminalStreams, Viewer } from "../herdr/terminal.js";
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

/** True when a viewer's socket has buffered more than it should be allowed to. */
export function isBackpressured(bufferedAmount: number, limit = MAX_BUFFERED_BYTES): boolean {
  return bufferedAmount > limit;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
}

/**
 * `/ws/terminal?pane=<id>&cols=<n>&rows=<n>`: attach the socket as a viewer of a
 * pane stream. Server → binary ANSI frames and JSON `TerminalServerMessage`
 * notices; client → JSON `TerminalClientMessage` control frames.
 */
export function registerTerminalWs(app: FastifyInstance, streams: TerminalStreams): void {
  app.get<{ Querystring: { pane?: string; cols?: string; rows?: string } }>(
    "/ws/terminal",
    { websocket: true, onRequest: wsOriginGuard },
    (socket, req) => {
      const pane = req.query.pane;
      if (typeof pane !== "string" || !PANE_RE.test(pane)) {
        socket.close(1008, "invalid pane");
        return;
      }
      heartbeat(socket);
      const cols = clamp(Number(req.query.cols), 20, 500, 80);
      const rows = clamp(Number(req.query.rows), 5, 200, 24);

      const viewer: Viewer = {
        send: (data) => {
          if (socket.readyState !== socket.OPEN) return;
          if (isBackpressured(socket.bufferedAmount)) {
            // Give up on a viewer that has fallen too far behind rather than
            // buffer unboundedly; the close triggers detach and, on reconnect,
            // a fresh repaint.
            try {
              socket.close(1013, "viewer too slow");
            } catch {
              // socket already gone
            }
            return;
          }
          socket.send(data, { binary: true });
        },
        sendJson: (m) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
        },
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
        let msg: TerminalClientMessage;
        try {
          msg = JSON.parse(raw.toString()) as TerminalClientMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          case "input":
            attachment.input(msg.text, msg.bytes);
            break;
          case "resize":
            attachment.resize(
              clamp(Number(msg.cols), 20, 500, cols),
              clamp(Number(msg.rows), 5, 200, rows),
            );
            break;
          case "scroll":
            if (msg.direction === "up" || msg.direction === "down") {
              attachment.scroll(msg.direction, Number(msg.lines));
            }
            break;
          case "focus":
            attachment.focus();
            break;
          default:
            break;
        }
      });

      socket.on("close", () => attachment.detach());
    },
  );
}
