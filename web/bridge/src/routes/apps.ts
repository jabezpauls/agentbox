import type { FastifyInstance, FastifyReply } from "fastify";
import { GateError, type AppFields } from "../apps/gate.js";
import { AppsError, type AppsService } from "../apps/service.js";

/**
 * `/api/apps*`: the app model for the app shell and for `agentbox-preview`
 * inside the sandbox. The records live in the gate (these routes pass the
 * sandbox's side of them through to its :7901 API); each comes back merged
 * with what is live in the sandbox. Who may open an app — its visibility — is
 * not here at all: that is the owner's, on the gate's public side.
 *
 *   GET    /api/apps                       → AppView[]
 *   POST   /api/apps {port, name?, cwd?, command?, pinned?, keepPrefix?} → AppView
 *   GET    /api/apps/:id                   → AppView
 *   PATCH  /api/apps/:id {…}               → AppView
 *   DELETE /api/apps/:id                   → 204
 *   POST   /api/apps/:id/open {by?, paneId?, path?}  every open tab shows it in Preview
 *   POST   /api/apps/:id/restart {workspaceId?}      (re)start its command in a herdr tab
 *   POST   /api/apps/:id/stop {remove?}              stop what serves it (and forget it)
 *   GET    /api/apps/:id/output?paneId=              the last lines of the pane it runs in
 */

const FIELDS = ["port", "name", "cwd", "command", "pinned", "keepPrefix", "compat"] as const;

function fields(body: unknown): AppFields {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  return Object.fromEntries(FIELDS.filter((k) => k in b).map((k) => [k, b[k]])) as AppFields;
}

function failed(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof GateError) return reply.code(err.status).send(err.body);
  if (err instanceof AppsError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

export function registerAppRoutes(app: FastifyInstance, apps: AppsService): void {
  app.get("/api/apps", async (_req, reply) => {
    try {
      return await apps.views();
    } catch (err) {
      return failed(reply, err);
    }
  });

  app.post("/api/apps", async (req, reply) => {
    try {
      return reply.code(201).send(await apps.create(fields(req.body)));
    } catch (err) {
      return failed(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/api/apps/:id", async (req, reply) => {
    try {
      const view = await apps.view(req.params.id);
      return view ?? reply.code(404).send({ error: "no such app" });
    } catch (err) {
      return failed(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/apps/:id", async (req, reply) => {
    try {
      return await apps.update(req.params.id, fields(req.body));
    } catch (err) {
      return failed(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/apps/:id", async (req, reply) => {
    try {
      if (!(await apps.remove(req.params.id))) return reply.code(404).send({ error: "no such app" });
      return reply.code(204).send();
    } catch (err) {
      return failed(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: { by?: unknown; paneId?: unknown; path?: unknown } | null }>(
    "/api/apps/:id/open",
    async (req, reply) => {
      try {
        await apps.open(req.params.id, req.body ?? {});
        return reply.code(204).send();
      } catch (err) {
        return failed(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { workspaceId?: unknown } | null }>("/api/apps/:id/restart", async (req, reply) => {
    try {
      return await apps.restart(req.params.id, req.body ?? {});
    } catch (err) {
      return failed(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: { remove?: unknown } | null }>("/api/apps/:id/stop", async (req, reply) => {
    try {
      const { stopped } = await apps.stop(req.params.id);
      let removed = false;
      if (req.body?.remove === true) {
        await apps.closeLaunched(req.params.id);
        removed = await apps.remove(req.params.id);
      }
      return { stopped, removed };
    } catch (err) {
      return failed(reply, err);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { paneId?: string; lines?: string } }>("/api/apps/:id/output", async (req, reply) => {
    const paneId = req.query.paneId;
    if (typeof paneId !== "string" || !/^[\w:.-]{1,64}$/.test(paneId)) return reply.code(400).send({ error: "paneId required" });
    try {
      const lines = Math.min(200, Math.max(1, Number(req.query.lines ?? 40) || 40));
      return { text: await apps.output(paneId, lines) };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
