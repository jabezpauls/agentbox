import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
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
import { registerPublicShareRoutes, registerShareApiRoutes, startExpirySweep, type ShareDeps } from "./routes/share.js";
import { ReviewStore } from "./review/store.js";
import { ShareStore } from "./share/store.js";
import { LiveShares } from "./share/live.js";
import { pathGuard } from "./path-guard.js";
import { FilesService } from "./files/service.js";
import { registerFilesRoutes } from "./files/routes.js";
import { SystemMonitor } from "./system.js";
import { registerSystemRoutes } from "./routes/system.js";
import { DAV_METHODS, registerDavRoutes, routableUrl } from "./files/dav/routes.js";

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
  /** How often to cut connections on expired shares; tests shorten it. */
  shareSweepMs?: number;
  /** Terminal stream registry; defaults to one bound to herdr's socket. */
  streams?: TerminalStreams;
  /** The files API's roots, trash and uploads; defaults to the configured roots. */
  files?: FilesService;
  /** The system view's sampler; defaults to one over the configured cgroup and roots. */
  system?: SystemMonitor;
}

/**
 * The app must not be framed by anyone else: a hostile page that could overlay
 * it would be clicking on live terminals and agents. Previews are framed *by*
 * the app, and they are served by the preview route rather than the static
 * one, so they are unaffected.
 */
const FRAME_GUARD: Record<string, string> = {
  "content-security-policy": "frame-ancestors 'self'",
  "x-frame-options": "SAMEORIGIN",
};

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, rewriteUrl: routableUrl });
  // WebDAV's verbs, for `/api/dav`. Declared on the root instance, before any
  // route, because the router's method table is shared.
  for (const m of DAV_METHODS) app.addHttpMethod(m, { hasBody: true });
  await app.register(websocket);
  // Before any route, so it covers every route and every websocket upgrade:
  // the decisive half of the public `/s/` boundary, and a refusal of ambiguous
  // paths. After the websocket plugin, whose own hook wires an upgrade's socket
  // to its reply — a refusal sent before that leaves the socket dangling.
  app.addHook("onRequest", pathGuard());

  const streams =
    deps.streams ??
    new TerminalStreams({ ...process.env, HERDR_SOCKET_PATH: config.socketPath });
  app.addHook("onClose", async () => streams.stop());

  const review = deps.review ?? new ReviewStore(config.reviewDir);
  const shares = deps.shares ?? new ShareStore(config.sharesDir);
  const live = new LiveShares();
  const infra = new Set(config.infraPorts);
  const shareDeps: ShareDeps = {
    store: shares,
    live,
    refusedPort: (port) => {
      if (infra.has(port)) return true;
      const addr = app.server.address();
      if (typeof addr === "object" && addr && addr.port === port) return true;
      // Whatever the classifier currently calls infrastructure (a host daemon
      // sharing the namespace, say) is off limits too.
      return deps.ports?.current().some((p) => p.port === port && p.system) ?? false;
    },
  };
  const stopSweep = startExpirySweep(shares, live, deps.shareSweepMs ?? 30_000);
  app.addHook("onClose", async () => stopSweep());

  const serveStatic = config.staticDir !== null && fs.existsSync(config.staticDir);

  // The public share route is the one route Caddy's unauthenticated public
  // branch reaches; `/s/…` is forwarded to the bridge unchanged.
  registerPublicShareRoutes(app, config, shareDeps);

  const files =
    deps.files ?? new FilesService({ workspaceRoot: config.workspaceRoot, homeRoot: config.homeRoot });

  registerApiRoutes(app, config, deps.hub, { ports: deps.ports });
  registerFilesRoutes(app, files);
  registerDavRoutes(app, files);
  registerSystemRoutes(
    app,
    deps.system ??
      new SystemMonitor({
        cgroupRoot: config.cgroupRoot,
        disks: [
          { label: "workspace", path: config.workspaceRoot },
          { label: "home", path: config.homeRoot },
        ],
        version: config.version,
        herdrVersion: () => deps.hub.version,
      }),
  );
  registerReviewRoutes(app, config, review);
  registerShareApiRoutes(app, config, shareDeps);
  registerEventsWs(app, deps.hub, deps.ports);
  registerTerminalWs(app, streams);
  await registerPreviewRoutes(app, config);

  // The app used to live under `/workbench/`, and links into it are out there:
  // bookmarks, and every review link an agent printed before the move. The
  // Workbench is now the app's `/workbench` route, so anything under the old
  // prefix lands there with its query kept — `?review=<key>` still opens the
  // review it named. `/workbench` itself is the app's and falls through to the
  // SPA below.
  app.route({
    method: ["GET", "HEAD"],
    url: "/workbench/*",
    handler: (req, reply) => {
      const q = req.url.indexOf("?");
      return reply.redirect(`/workbench${q === -1 ? "" : req.url.slice(q)}`, 301);
    },
  });

  if (serveStatic) {
    await app.register(fastifyStatic, {
      root: config.staticDir as string,
      prefix: "/",
      // Set per file below: the plugin's one policy would fit neither kind.
      cacheControl: false,
      setHeaders: (res, file) => {
        for (const [name, value] of Object.entries(FRAME_GUARD)) res.setHeader(name, value);
        // Built assets carry a content hash in their names, so they never
        // change; everything else — the page that names them above all — is
        // revalidated, or a browser keeps asking for the previous build's.
        const hashed = file.startsWith(path.join(config.staticDir as string, "assets") + path.sep);
        res.setHeader("cache-control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
  }

  // History-API routing: a navigation to any path the app owns (`/files/…`,
  // `/apps/…`, `/settings/…`) is answered with index.html and routed on the
  // client, so a deep link survives a reload.
  app.setNotFoundHandler((req, reply) => {
    if (serveStatic && isAppNavigation(req)) {
      return reply
        .headers({ ...FRAME_GUARD, "cache-control": "no-cache" })
        .type("text/html")
        .sendFile("index.html");
    }
    return reply.code(404).send({ error: "not found" });
  });

  return app;
}

/**
 * Paths the app never answers for: the API, the sockets, the proxies and the
 * built assets. A miss under one of them is a real 404 — a stale asset URL
 * should fail loudly, not parse a page as JavaScript.
 */
const NOT_THE_APP = /^\/(api|ws|preview|s|assets)(\/|$)/;

/** Fetch destinations that are page loads rather than subresources. */
const PAGE_DESTINATIONS = new Set(["document", "iframe", "frame"]);

/** True for a GET or HEAD that should be answered with the app's index.html. */
function isAppNavigation(req: FastifyRequest): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const path = req.url.split("?")[0] ?? "";
  if (NOT_THE_APP.test(path)) return false;
  // A browser says what a request is for, so a script or image load of a path
  // that does not exist is never handed a page. Clients that do not say (curl,
  // older browsers) are treated as navigating.
  const dest = req.headers["sec-fetch-dest"];
  return typeof dest !== "string" || PAGE_DESTINATIONS.has(dest);
}
