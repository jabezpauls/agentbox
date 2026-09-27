import type { FastifyInstance } from "fastify";
import type { SystemMonitor } from "../system.js";

/** `GET /api/system`: CPU, memory, PIDs, disks, uptime, top processes, versions. */
export function registerSystemRoutes(app: FastifyInstance, monitor: SystemMonitor): void {
  app.get("/api/system", async (_req, reply) => {
    // A reading, not a document: never let a cache answer with a stale one.
    reply.header("cache-control", "no-store");
    return monitor.info();
  });
}
