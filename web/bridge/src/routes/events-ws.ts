import type { FastifyInstance } from "fastify";
import type { EventsMessage } from "@workbench/shared";
import type { SessionHub } from "../herdr/session.js";
import type { PortsWatcher } from "../app.js";

/**
 * `/ws/events`: on open send a fresh snapshot and the current listening ports,
 * then forward every hub message verbatim and push port changes as they occur.
 * The ports watcher polls only while at least one events client is connected,
 * so this route ref-counts it: started on the first client, stopped on the last.
 */
export function registerEventsWs(
  app: FastifyInstance,
  hub: SessionHub,
  ports?: PortsWatcher,
): void {
  let clientCount = 0;

  app.get("/ws/events", { websocket: true }, (socket) => {
    let off: (() => void) | null = null;
    let offPorts: (() => void) | null = null;

    const send = (m: EventsMessage): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };

    clientCount += 1;
    if (ports && clientCount === 1) ports.start();

    hub
      .snapshot()
      .then((snapshot) => {
        if (socket.readyState !== socket.OPEN) return;
        send({ kind: "snapshot", snapshot });
        if (ports) {
          send({ kind: "ports", ports: ports.current() });
          offPorts = ports.on((p) => send({ kind: "ports", ports: p }));
        }
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
      if (offPorts) offPorts();
      offPorts = null;
      clientCount -= 1;
      if (ports && clientCount === 0) ports.stop();
    });
  });
}
