import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type { ListeningPort } from "@workbench/shared";
import type { Config } from "./config.js";
import type { SessionHub } from "./herdr/session.js";
import { TerminalStreams } from "./herdr/terminal.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerEventsWs } from "./routes/events-ws.js";
import { registerTerminalWs } from "./routes/terminal-ws.js";
import { registerPreviewRoutes } from "./routes/preview.js";
import { registerReviewRoutes } from "./routes/review.js";
import { registerPublicShareRoutes, registerShareApiRoutes } from "./routes/share.js";
import { ReviewStore } from "./review/store.js";
import { ShareStore } from "./share/store.js";
import { pathGuard } from "./path-guard.js";

/**
 * Watches for locally listening ports. Polling runs only between `start()` and
 * `stop()` so the events websocket can ref-count it against connected clients.
 */
export interface PortsWatcher {
  current(): ListeningPort[];
  /** False when the last poll could not read `/proc` at all. */
  readable(): boolean;
  on(listener: (ports: ListeningPort[]) => void): () => void;
  start(): void;
  stop(): void;
}

export interface AppDeps {
  hub: SessionHub;
  ports?: PortsWatcher;
  /** Review session store; defaults to one rooted at the configured directory. */
  review?: ReviewStore;
  /** Public preview share store; defaults to one rooted at the configured dir. */
  shares?: ShareStore;
  /** Terminal stream registry; defaults to one bound to herdr's socket. */
  streams?: TerminalStreams;
}

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  // Before any route, so it covers every route and every websocket upgrade:
  // the decisive half of the public `/s/` boundary, and a refusal of ambiguous
  // paths. After the websocket plugin, whose own hook wires an upgrade's socket
  // to its reply — a refusal sent before that leaves the socket dangling.
  app.addHook("onRequest", pathGuard(config.basePath));

  const streams =
    deps.streams ??
    new TerminalStreams({ ...process.env, HERDR_SOCKET_PATH: config.socketPath });
  app.addHook("onClose", async () => streams.stop());

  const review = deps.review ?? new ReviewStore(config.reviewDir);
  const shares = deps.shares ?? new ShareStore(config.sharesDir);

  const serveStatic = config.staticDir !== null && fs.existsSync(config.staticDir);

  // The public share route lives at the server root, outside the base-path
  // scope: Caddy's unauthenticated public branch forwards `/s/…` to the bridge
  // unchanged, so it must not sit under `/workbench`.
  registerPublicShareRoutes(app, config, shares);

  await app.register(
    async (scope) => {
      registerApiRoutes(scope, config, deps.hub, { ports: deps.ports });
      registerReviewRoutes(scope, config, review);
      registerShareApiRoutes(scope, config, shares);
      registerEventsWs(scope, deps.hub, deps.ports);
      registerTerminalWs(scope, streams);
      await registerPreviewRoutes(scope, config);

      if (serveStatic) {
        // The Workbench must not be framed by anyone else: a hostile page that
        // could overlay it would be clicking on live terminals and agents.
        // Previews are framed *by* the app, and they are served by the preview
        // route rather than this one, so they are unaffected.
        const FRAME_GUARD: Record<string, string> = {
          "content-security-policy": "frame-ancestors 'self'",
          "x-frame-options": "SAMEORIGIN",
        };

        await scope.register(fastifyStatic, {
          root: config.staticDir as string,
          prefix: "/",
          setHeaders: (res) => {
            for (const [name, value] of Object.entries(FRAME_GUARD)) res.setHeader(name, value);
          },
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
            return reply.headers(FRAME_GUARD).type("text/html").sendFile("index.html");
          }
          return reply.code(404).send({ error: "not found" });
        });
      }
    },
    { prefix: config.basePath },
  );

  return app;
}
