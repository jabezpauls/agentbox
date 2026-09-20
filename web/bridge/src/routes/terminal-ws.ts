import type { FastifyInstance } from "fastify";
import type { TerminalClientMessage } from "@workbench/shared";
import type { TerminalStreams, Viewer } from "../herdr/terminal.js";

const PANE_RE = /^w\d+:p\d+$/;

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
    { websocket: true },
    (socket, req) => {
      const pane = req.query.pane;
      if (typeof pane !== "string" || !PANE_RE.test(pane)) {
        socket.close(1008, "invalid pane");
        return;
      }
      const cols = clamp(Number(req.query.cols), 20, 500, 80);
      const rows = clamp(Number(req.query.rows), 5, 200, 24);

      const viewer: Viewer = {
        send: (data) => {
          if (socket.readyState === socket.OPEN) socket.send(data, { binary: true });
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
            attachment.scroll(msg.direction, Number(msg.lines));
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
