import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { request, HerdrError } from "../herdr/socket.js";
import { isAllowed } from "../rpc-allowlist.js";
import type { SessionHub } from "../herdr/session.js";

/** Register health, session snapshot, and the allowlisted RPC forwarder. */
export function registerApiRoutes(app: FastifyInstance, config: Config, hub: SessionHub): void {
  app.get("/api/health", () => ({
    ok: true,
    herdr: { connected: hub.connected, version: hub.version, protocol: hub.protocol },
  }));

  app.get("/api/session", () => hub.snapshot());

  app.post("/api/rpc", async (req, reply) => {
    const body = req.body as { method?: unknown; params?: unknown } | null | undefined;
    const method = body?.method;
    if (typeof method !== "string") {
      return reply.code(400).send({ error: "method required" });
    }
    if (!isAllowed(method)) {
      return reply.code(403).send({ error: "method not allowed" });
    }
    const params =
      body && typeof body.params === "object" && body.params !== null
        ? (body.params as Record<string, unknown>)
        : {};
    try {
      const result = await request(config.socketPath, method, params);
      return { result };
    } catch (err) {
      if (err instanceof HerdrError) {
        return reply.code(502).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });
}
