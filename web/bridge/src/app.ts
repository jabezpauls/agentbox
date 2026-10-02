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
import { registerReviewRoutes } from "./routes/review.js";
import { ReviewStore } from "./review/store.js";
import { pathGuard } from "./path-guard.js";
import { FilesService } from "./files/service.js";
import { registerFilesRoutes } from "./files/routes.js";
import { SystemMonitor } from "./system.js";
import { registerSystemRoutes } from "./routes/system.js";
import { BridgeEvents } from "./events.js";
import { Projects } from "./projects.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { EditorChannel } from "./editor.js";
import { registerEditorRoutes } from "./routes/editor.js";
import { listListeningPorts } from "./ports.js";
import { DAV_METHODS, registerDavRoutes, routableUrl } from "./files/dav/routes.js";
import { AppsService } from "./apps/service.js";
import { gateApps } from "./apps/gate.js";
import { registerAppRoutes } from "./routes/apps.js";
import { request as herdrRequest } from "./herdr/socket.js";

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
  /** Terminal stream registry; defaults to one bound to herdr's socket. */
  streams?: TerminalStreams;
  /** The files API's roots, trash and uploads; defaults to the configured roots. */
  files?: FilesService;
  /** The system view's sampler; defaults to one over the configured cgroup and roots. */
  system?: SystemMonitor;
  /** The bridge's own events, fanned out on /ws/events next to herdr's. */
  events?: BridgeEvents;
  /** The project cards; defaults to one over the workspace root and the live ports. */
  projects?: Projects;
  /** The editor channel the VS Code extension connects to. */
  editor?: EditorChannel;
  /** Apps: the gate's records with their live state; defaults to the configured gate. */
  apps?: AppsService;
}

/**
 * The app must not be framed by anyone else: a hostile page that could overlay
 * it would be clicking on live terminals and agents. Apps are framed *by* the
 * app, and they are served by the data plane, not here, so they are unaffected.
 *
 * And the page runs only its own scripts. The build has no inline script, no
 * eval and no plugin, so a script that found its way into the page — through
 * a rendered README, say, past the sanitiser — has nothing to run with. Frames,
 * images, styles and sockets are left open: the editor, apps on their own
 * origin, pasted pictures and React's inline styles all need them.
 */
export const APP_CSP = "frame-ancestors 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";

/**
 * The microphone is the page's own, for dictation in the composers, and no
 * other origin's: an app in a frame (opaque, under its sandbox) never has it,
 * and the gate denies it to `/a/` outright as well.
 */
export const APP_PERMISSIONS = "microphone=(self)";

const FRAME_GUARD: Record<string, string> = {
  "content-security-policy": APP_CSP,
  "permissions-policy": APP_PERMISSIONS,
  "x-frame-options": "SAMEORIGIN",
};

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, rewriteUrl: routableUrl });
  // WebDAV's verbs, for `/api/dav`. Declared on the root instance, before any
  // route, because the router's method table is shared.
  for (const m of DAV_METHODS) app.addHttpMethod(m, { hasBody: true });
  await app.register(websocket);
  // Before any route, so it covers every route and every websocket upgrade: a
  // refusal of ambiguous paths. After the websocket plugin, whose own hook
  // wires an upgrade's socket to its reply — a refusal sent before that leaves
  // the socket dangling.
  app.addHook("onRequest", pathGuard());

  const streams =
    deps.streams ??
    new TerminalStreams({ ...process.env, HERDR_SOCKET_PATH: config.socketPath });
  app.addHook("onClose", async () => streams.stop());

  const review = deps.review ?? new ReviewStore(config.reviewDir);
  const serveStatic = config.staticDir !== null && fs.existsSync(config.staticDir);

  const files =
    deps.files ?? new FilesService({ workspaceRoot: config.workspaceRoot, homeRoot: config.homeRoot });
  const events = deps.events ?? new BridgeEvents();
  const projects =
    deps.projects ??
    new Projects({
      files,
      snapshot: () => deps.hub.snapshot(),
      // A fresh scan rather than the watcher's list, which is only kept
      // current while an events client is connected.
      scanPorts: async () =>
        (await listListeningPorts({ systemPorts: config.infraPorts, workspaceRoot: config.workspaceRoot })).ports,
      events,
    });
  app.addHook("onClose", async () => projects.stop());
  const editor = deps.editor ?? new EditorChannel();
  app.addHook("onClose", async () => editor.close());
  const apps =
    deps.apps ??
    new AppsService({
      gate: gateApps(config.gateAppsUrl),
      events,
      scanPorts: async () =>
        (await listListeningPorts({ systemPorts: config.infraPorts, workspaceRoot: config.workspaceRoot })).ports,
      snapshot: () => deps.hub.snapshot(),
      herdr: (method, params) => herdrRequest(config.socketPath, method, params ?? {}),
      herdrReady: () => deps.hub.connected,
    });
  app.addHook("onClose", async () => apps.stopWatching());

  registerApiRoutes(app, config, deps.hub, { ports: deps.ports, sharing: () => apps.sharing });
  registerAppRoutes(app, apps);
  registerProjectRoutes(app, projects);
  registerEditorRoutes(app, editor, files);
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
  registerEventsWs(app, deps.hub, deps.ports, events);
  registerTerminalWs(app, streams);

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
 * Paths the app never answers for: the API, the sockets and the built assets.
 * A miss under one of them is a real 404 — a stale asset URL should fail
 * loudly, not parse a page as JavaScript.
 */
const NOT_THE_APP = /^\/(api|ws|assets)(\/|$)/;

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
