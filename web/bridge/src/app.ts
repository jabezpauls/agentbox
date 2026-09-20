import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type { LavishState, ListeningPort } from "@workbench/shared";
import type { Config } from "./config.js";
import type { SessionHub } from "./herdr/session.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerEventsWs } from "./routes/events-ws.js";

/** Watches for locally listening ports; wired into the app in a later task. */
export interface PortsWatcher {
  current(): ListeningPort[];
  on(listener: (ports: ListeningPort[]) => void): () => void;
}

export interface AppDeps {
  hub: SessionHub;
  ports?: PortsWatcher;
  lavish?: () => Promise<LavishState>;
}

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  const serveStatic = config.staticDir !== null && fs.existsSync(config.staticDir);

  await app.register(
    async (scope) => {
      registerApiRoutes(scope, config, deps.hub);
      registerEventsWs(scope, deps.hub);

      if (serveStatic) {
        await scope.register(fastifyStatic, {
          root: config.staticDir as string,
          prefix: "/",
        });
        // SPA fallback: any GET under the prefix that is not an API, websocket,
        // or preview route serves index.html so client-side routing works.
        scope.setNotFoundHandler((req, reply) => {
          const rel = req.url.split("?")[0]?.slice(config.basePath.length) ?? "";
          if (
            req.method === "GET" &&
            !rel.startsWith("/api") &&
            !rel.startsWith("/ws") &&
            !rel.startsWith("/preview")
          ) {
            return reply.type("text/html").sendFile("index.html");
          }
          return reply.code(404).send({ error: "not found" });
        });
      }
    },
    { prefix: config.basePath },
  );

  return app;
}
