import type { FastifyInstance } from "fastify";
import type { EventsMessage } from "@workbench/shared";
import type { SessionHub } from "../herdr/session.js";

/**
 * `/ws/events`: on open send a fresh snapshot, then forward every hub message
 * verbatim as JSON. The hub's own subscription is always open, so a client that
 * connects loses nothing between snapshots.
 */
export function registerEventsWs(app: FastifyInstance, hub: SessionHub): void {
  app.get("/ws/events", { websocket: true }, (socket) => {
    let off: (() => void) | null = null;

    const send = (m: EventsMessage): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };

    hub
      .snapshot()
      .then((snapshot) => {
        if (socket.readyState !== socket.OPEN) return;
        send({ kind: "snapshot", snapshot });
        off = hub.on(send);
      })
      .catch(() => {
        try {
          socket.close();
        } catch {
          // socket already gone
        }
      });

    socket.on("close", () => {
      if (off) off();
      off = null;
    });
  });
}
