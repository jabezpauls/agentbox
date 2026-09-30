import type { FastifyInstance } from "fastify";
import type { EventsMessage } from "@workbench/shared";
import type { SessionHub } from "../herdr/session.js";
import type { PortsWatcher } from "../app.js";
import type { BridgeEvents } from "../events.js";
import { wsOriginGuard } from "../ws-origin.js";
import { heartbeat } from "../ws-heartbeat.js";

/**
 * `/ws/events`: on open send a fresh snapshot and the current listening ports,
 * then forward every hub message verbatim, push port changes as they occur,
 * and pass on the bridge's own events (a clone's progress, say).
 * The ports watcher polls only while at least one events client is connected,
 * so this route ref-counts it: started on the first client, stopped on the last.
 */
export function registerEventsWs(
  app: FastifyInstance,
  hub: SessionHub,
  ports?: PortsWatcher,
  events?: BridgeEvents,
): void {
  let clientCount = 0;

  app.get("/ws/events", { websocket: true, onRequest: wsOriginGuard }, (socket) => {
    let off: (() => void) | null = null;
    let offPorts: (() => void) | null = null;
    let offEvents: (() => void) | null = null;

    const send = (m: EventsMessage): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };

    heartbeat(socket);
    clientCount += 1;
    if (ports && clientCount === 1) ports.start();
    // Subscribed at once rather than after the snapshot: a clone's progress
    // does not depend on herdr and should not wait on it.
    if (events) offEvents = events.on(send);

    hub
      .snapshot()
      .then((snapshot) => {
        if (socket.readyState !== socket.OPEN) return;
        send({ kind: "snapshot", snapshot });
        if (ports) {
          send({ kind: "ports", ports: ports.current(), readable: ports.readable() });
          offPorts = ports.on((p) => send({ kind: "ports", ports: p, readable: ports.readable() }));
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
      if (offEvents) offEvents();
      offEvents = null;
      clientCount -= 1;
      if (ports && clientCount === 0) ports.stop();
    });
  });
}
