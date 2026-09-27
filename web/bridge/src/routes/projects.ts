import type { FastifyInstance } from "fastify";
import { sendError } from "../files/routes.js";
import type { Projects } from "../projects.js";

type Body = Record<string, unknown> | undefined;

/**
 * `/api/projects`: the workspace's top-level folders as project cards, and
 * making new ones — empty, or cloned (answered at once; progress arrives as
 * `project.clone` events on `/ws/events`).
 */
export function registerProjectRoutes(app: FastifyInstance, projects: Projects): void {
  app.get("/api/projects", async (_req, reply) => {
    try {
      return await projects.list();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: Body }>("/api/projects", async (req, reply) => {
    try {
      const project = await projects.create(req.body ?? {});
      return reply.code(201).send(project);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: Body }>("/api/projects/clone", async (req, reply) => {
    try {
      const started = await projects.clone(req.body ?? {});
      return reply.code(202).send(started);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Cancel a clone in progress; it ends with a `cancelled` event.
  app.delete<{ Params: { id: string } }>("/api/projects/clone/:id", async (req, reply) => {
    if (!projects.cancel(req.params.id)) return reply.code(404).send({ error: "no clone in progress by that id" });
    return reply.code(204).send();
  });
}
