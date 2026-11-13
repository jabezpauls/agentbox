import type { FastifyInstance } from "fastify";
import { serveTerminalSocket, type TerminalStreams } from "@workbench/hostcore";
import { wsOriginGuard } from "../ws-origin.js";

// The protocol itself is shared with a machine's node (hostcore).
export { isBackpressured, MAX_CHANNELS, muxFrame } from "@workbench/hostcore";

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
    (socket, req) => serveTerminalSocket(socket, streams, req.query),
  );
}
