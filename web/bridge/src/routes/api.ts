import type { FastifyInstance } from "fastify";
import type { LavishState } from "@workbench/shared";
import type { Config } from "../config.js";
import { request, HerdrError } from "../herdr/socket.js";
import { isAllowed } from "../rpc-allowlist.js";
import type { SessionHub } from "../herdr/session.js";
import type { PortsWatcher } from "../app.js";
import { listDirs } from "../fs.js";

export interface ApiDeps {
  ports?: PortsWatcher | undefined;
  lavish?: (() => Promise<LavishState>) | undefined;
}

/** Register health, session snapshot, the allowlisted RPC forwarder, and the
 * ports, filesystem, and lavish read endpoints. */
export function registerApiRoutes(
  app: FastifyInstance,
  config: Config,
  hub: SessionHub,
  deps: ApiDeps = {},
): void {
  app.get("/api/health", () => ({
    ok: true,
    herdr: { connected: hub.connected, version: hub.version, protocol: hub.protocol },
  }));

  app.get("/api/session", () => hub.snapshot());

  app.get("/api/ports", () => (deps.ports ? deps.ports.current() : []));

  app.get("/api/lavish", async () =>
    deps.lavish ? deps.lavish() : { configured: false, url: null, running: false, sessions: [] },
  );

  app.get<{ Querystring: { path?: string } }>("/api/fs/dirs", async (req, reply) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    try {
      return await listDirs(config.workspaceRoot, rel);
    } catch (err) {
      if (err instanceof RangeError) {
        return reply.code(400).send({ error: "path escapes workspace root" });
      }
      throw err;
    }
  });

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
