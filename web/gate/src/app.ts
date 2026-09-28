import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { registerApi } from "./api.js";
import { AppGateway } from "./app-access.js";
import { AppRegistry } from "./apps.js";
import { Auth, type Ended, type Subject } from "./auth.js";
import { ClientIpResolver, limitKey, normalizeIp } from "./client-ip.js";
import type { Config } from "./config.js";
import { peekInfo, setInfo, type GateCore, type RequestInfo } from "./context.js";
import { DeviceFlow } from "./device.js";
import { Grants } from "./grants.js";
import { createSandboxApi } from "./sandbox-api.js";
import { isSafeMethod, isSameOriginRequest, originMatchesHost } from "./origin.js";
import { PasswordChecker } from "./password.js";
import { canonicalPath, isRoutablePath, splitTarget } from "./path-guard.js";
import { proxyHttp, proxyUpgrade, refuseUpgrade, SECURITY_HEADERS, type Forwarded } from "./proxy.js";
import { LOGIN_LIMITS, LoginLimiter, WindowLimiter, type LoginLimits } from "./ratelimit.js";
import { EDITOR_PREFIX, route } from "./routes.js";
import { Store } from "./store.js";

/**
 * The gate: every request to the box passes through here.
 *
 * A raw `http.Server` does the dispatching, in this order, for plain requests
 * and WebSocket upgrades alike:
 *
 * 1. the path guard refuses (400) any raw path two parsers could read
 *    differently, before anything else looks at it;
 * 2. a service worker's script is refused (403) outside the editor;
 * 3. the client's address is settled (forwarding headers count only from the
 *    proxy);
 * 4. the route table picks the destination from the path;
 * 5. the gate's own paths go to Fastify, under a deadline; an app's path
 *    (`/a/<id>/…`) goes to the app gateway, which applies the app policy
 *    (app-access.ts); the CLI's tunnels take a device token and nothing else;
 *    everything else needs a session or a device token, passes the
 *    same-origin checks, and is forwarded with every front-door credential
 *    stripped.
 *
 * Beside the public listener, the sandbox-side app API (sandbox-api.ts) has a
 * listener of its own, which the proxy never forwards to.
 *
 * Proxied traffic never touches Fastify, so no body parser, router quirk or
 * length limit of Fastify's stands between a request and its upstream.
 */

export interface GateTimeouts {
  /** Every request's headers must arrive within this. */
  headersMs: number;
  /**
   * A request to the gate's own endpoints — sign-in, the API, its pages — must
   * be answered within this, body included, or its connection is closed.
   * Proxied requests and upgrades are never timed: an upload or a terminal is
   * the upstream's business.
   */
  gateRequestMs: number;
}

export const GATE_TIMEOUTS: GateTimeouts = { headersMs: 20_000, gateRequestMs: 30_000 };

export interface GateDeps {
  now?: () => number;
  limits?: LoginLimits;
  /** DNS for the trusted proxy's name; tests substitute their own. */
  lookup?: (host: string) => Promise<string[]>;
  timeouts?: Partial<GateTimeouts>;
}

export interface Gate {
  app: FastifyInstance;
  server: http.Server;
  /** The sandbox-side app API, listened on separately (main.ts: :7901). */
  sandboxServer: http.Server;
  core: GateCore;
  apps: AppGateway;
  /** The session or device token a request carries, if any. */
  authenticate(req: IncomingMessage): Subject | null;
  close(): Promise<void>;
}

/** Periodic cleanup of expired sessions and device logins. */
const PRUNE_MS = 10 * 60_000;
/** WebSocket traffic counts as use of its session at most this often. */
const SOCKET_TOUCH_MS = 30_000;

function plain(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra };
  // Every answer here refuses or redirects a request the gate will not pass
  // on. Closing the connection after it means a body still trickling in — to
  // a route the gate never reads — cannot hold the socket.
  headers.connection = "close";
  for (const [n, v] of SECURITY_HEADERS) headers[n] = v;
  res.writeHead(status, headers);
  res.end(`${text}\n`);
}

/**
 * A page load rather than a script's request: the browser should be sent to
 * sign in, where a `fetch` should get a status it can act on.
 */
function isNavigation(req: IncomingMessage): boolean {
  if (!isSafeMethod(req.method)) return false;
  const mode = req.headers["sec-fetch-mode"];
  if (typeof mode === "string") return mode === "navigate";
  return String(req.headers.accept ?? "").includes("text/html");
}

/**
 * A browser fetching a service worker's script says so (`Service-Worker:
 * script`). A worker controls every page in its scope — it could answer
 * `/login` with a lookalike, for good — and the only workers this origin
 * needs are code-server's, under the editor's prefix. So a worker's script is
 * refused anywhere else, whoever serves it; with `Service-Worker-Allowed`
 * stripped from every response, no worker's scope can reach above its script,
 * so none can reach the gate's own pages.
 */
function isRefusedServiceWorker(req: IncomingMessage, path: string): boolean {
  return req.headers["service-worker"] !== undefined && !path.startsWith(`${EDITOR_PREFIX}/`);
}

export async function buildGate(config: Config, deps: GateDeps = {}): Promise<Gate> {
  const now = deps.now ?? Date.now;
  const timeouts: GateTimeouts = { ...GATE_TIMEOUTS, ...(deps.timeouts ?? {}) };
  const store = await Store.open(config.dataDir, config.seedPasswordHash, now());
  const auth = new Auth(store, now);
  const devices = new DeviceFlow(store, auth, now);
  const clientIps = new ClientIpResolver(config.trustedProxies, deps.lookup);
  // Resolve the proxy's name before taking traffic (bounded: a proxy that is
  // not up yet is looked for again in the background).
  await Promise.race([clientIps.start(), new Promise((r) => setTimeout(r, 2_000).unref())]);

  const core: GateCore = {
    config,
    store,
    auth,
    devices,
    limiter: new LoginLimiter(deps.limits ?? LOGIN_LIMITS, now),
    passcodes: new LoginLimiter(deps.limits ?? LOGIN_LIMITS, now),
    deviceStarts: new WindowLimiter(10, 60_000, now),
    devicePolls: new WindowLimiter(60, 60_000, now),
    totpConfirms: new WindowLimiter(10, 60_000, now),
    passwords: new PasswordChecker(config.bcryptCost),
    now,
    authenticate: (req) => auth.authenticate(req, peekInfo(req)?.ip ?? normalizeIp(req.socket.remoteAddress ?? "")),
    apps: new AppRegistry(store, { infraPorts: config.infraPorts, sharing: config.sharing, now }),
  };
  const grants = new Grants(store);
  const appGateway = new AppGateway({
    core,
    registry: core.apps,
    grants,
    dataPlane: config.dataPlane,
    // Refused lookups of apps, per address: 60 a minute, so no one can
    // enumerate ids (they are 128 random bits besides).
    probes: new WindowLimiter(60, 60_000, now),
    // Thirty wrong passcodes for one app in ten minutes, from anywhere, and
    // that app's passcode page waits: 4,320 guesses a day at most.
    passcodeMisses: new WindowLimiter(30, 10 * 60_000, now),
    forwarded: (info) => forwarded(info),
  });
  const sandboxServer = createSandboxApi(core.apps, clientIps);

  function settle(req: IncomingMessage): RequestInfo {
    const who = clientIps.resolve(req);
    const claimedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
    const info: RequestInfo = {
      ip: who.ip,
      key: limitKey(who.ip),
      viaProxy: who.viaProxy,
      proto: who.viaProxy && (claimedProto === "https" || claimedProto === "http") ? claimedProto : "http",
      host: String(req.headers.host ?? ""),
    };
    setInfo(req, info);
    return info;
  }

  function forwarded(info: RequestInfo): Forwarded {
    return { clientIp: info.ip, proto: info.proto, host: info.host };
  }

  // Every upgraded connection, by the credential that opened it. A WebSocket
  // outlives the request that authenticated it, so every way a session or a
  // token ends — sign-out, idle, expiry, eviction, a password change,
  // revoke-all — cuts what it has open, a live terminal above all.
  const liveSockets = { session: new Map<string, Set<Duplex>>(), token: new Map<string, Set<Duplex>>() };
  function trackSocket(subject: Subject, socket: Duplex): void {
    const byId = liveSockets[subject.kind];
    let set = byId.get(subject.id);
    if (!set) byId.set(subject.id, (set = new Set()));
    set.add(socket);
    socket.once("close", () => {
      set.delete(socket);
      if (set.size === 0 && byId.get(subject.id) === set) byId.delete(subject.id);
    });
  }
  auth.onEnded((ended: Ended) => {
    const byId = liveSockets[ended.kind];
    const ids = "ids" in ended ? ended.ids : [...byId.keys()].filter((id) => id !== ended.allBut);
    for (const id of ids) for (const socket of byId.get(id) ?? []) socket.destroy();
  });

  let fastifyHandler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;

  function toGate(req: IncomingMessage, res: ServerResponse): void {
    // The whole request — its body included — must arrive in time. Watching
    // the request rather than the response matters: the gate may answer early
    // (a refused origin) while a trickled body still holds the connection.
    const socket = req.socket;
    const timer = setTimeout(() => socket.destroy(), timeouts.gateRequestMs);
    timer.unref();
    const stop = (): void => clearTimeout(timer);
    // Removed again when the request ends: a keep-alive socket carries many
    // requests, and must not collect one listener per request.
    socket.once("close", stop);
    req.once("end", () => {
      stop();
      socket.off("close", stop);
    });
    (fastifyHandler as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = splitTarget(req.url ?? "");
    if (!isRoutablePath(target.path)) {
      plain(res, 400, "bad path");
      return;
    }
    // Everything from here on — the route, the way back after signing in, the
    // path forwarded — sees the one canonical spelling.
    const path = canonicalPath(target.path);
    const { query } = target;
    if (isRefusedServiceWorker(req, path)) {
      plain(res, 403, "service workers are not allowed here");
      return;
    }
    const info = settle(req);
    const r = route(path, query);

    if (r.kind === "gate") {
      toGate(req, res);
      return;
    }
    if (r.kind === "redirect") {
      plain(res, 308, "moved", { location: r.location });
      return;
    }
    if (r.kind === "notFound") {
      plain(res, 404, "not found");
      return;
    }
    if (r.kind === "app") {
      await appGateway.handle(req, res, r, info);
      return;
    }
    if (r.kind === "tunnel") {
      plain(res, 426, "a tunnel is a WebSocket", { upgrade: "websocket" });
      return;
    }

    const subject = core.authenticate(req);
    if (!subject) {
      if (isNavigation(req)) {
        const next = query === null ? path : `${path}?${query}`;
        plain(res, 302, "sign in first", { location: `/login?next=${encodeURIComponent(next)}` });
      } else {
        // The app reads this header to send the page to sign in.
        plain(res, 401, "sign in first", { "x-agentbox-login": "/login" });
      }
      return;
    }
    if (subject.kind === "session" && !isSafeMethod(req.method) && !isSameOriginRequest(req.headers)) {
      plain(res, 403, "request refused: it did not come from this site");
      return;
    }
    proxyHttp(config.upstreams[r.upstream], req, res, {
      target: r.target,
      forwarded: forwarded(info),
      // code-server's own workers may scope themselves to /vscode/, no higher.
      ...(r.upstream === "code" ? { serviceWorkerPrefix: EDITOR_PREFIX } : {}),
    });
  }

  /**
   * A tunnel for the CLI: a TCP port on the sandbox's loopback, or herdr's
   * socket, as a WebSocket of raw bytes (binary frames both ways; a text frame
   * `{"type":"error","message"}` before a close says why). A device token
   * only: a tunnel is how `agentbox forward` reaches a port, and a page on
   * another site must never be able to open one on a browser's cookie.
   * Infrastructure ports are allowed here — the token holder is the owner.
   */
  function tunnel(req: IncomingMessage, socket: Duplex, head: Buffer, query: string | null, info: RequestInfo): void {
    const subject = core.authenticate(req);
    if (!subject || subject.kind !== "token") return refuseUpgrade(socket, 401, "Unauthorized");
    const target = new URLSearchParams(query ?? "").get("target") ?? "";
    let path: string;
    const tcp = /^tcp:(\d{1,5})$/.exec(target);
    if (tcp && Number(tcp[1]) >= 1 && Number(tcp[1]) <= 65535) path = `/tunnel/tcp/${Number(tcp[1])}`;
    else if (target === "herdr") path = "/tunnel/herdr";
    else return refuseUpgrade(socket, 400, "Bad Request");
    trackSocket(subject, socket);
    console.log(`[gate] tunnel to ${target} for "${subject.token.name}" from ${info.ip}`);
    proxyUpgrade(config.dataPlane, req, socket, head, { target: path, forwarded: forwarded(info) });
  }

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on("error", () => socket.destroy());
    const target = splitTarget(req.url ?? "");
    if (!isRoutablePath(target.path)) return refuseUpgrade(socket, 400, "Bad Request");
    const path = canonicalPath(target.path);
    const { query } = target;
    const info = settle(req);
    const r = route(path, query);
    if (r.kind === "app") return appGateway.upgrade(req, socket, head, r, info);
    if (r.kind === "tunnel") return tunnel(req, socket, head, query, info);
    // The gate's own routes take no other upgrades; nor does a redirect, nor
    // the editor channel, which is for the extension inside the sandbox alone.
    if (r.kind !== "upstream") return refuseUpgrade(socket, 404, "Not Found");
    const subject = core.authenticate(req);
    if (!subject) return refuseUpgrade(socket, 401, "Unauthorized");
    // A WebSocket handshake is not covered by the same-origin policy: without
    // this, any page in another tab could open a terminal on the session
    // cookie. A device token is not ambient, so it needs no such check.
    if (subject.kind === "session" && !originMatchesHost(req.headers)) return refuseUpgrade(socket, 403, "Forbidden");
    trackSocket(subject, socket);
    let lastTouch = 0;
    const onClientData =
      subject.kind === "session"
        ? () => {
            const t = now();
            if (t - lastTouch < SOCKET_TOUCH_MS) return;
            lastTouch = t;
            auth.touchSession(subject.id);
          }
        : undefined;
    proxyUpgrade(config.upstreams[r.upstream], req, socket, head, {
      target: r.target,
      forwarded: forwarded(info),
      ...(onClientData ? { onClientData } : {}),
    });
  }

  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    serverFactory: (handler) => {
      fastifyHandler = handler;
      const server = http.createServer(
        {
          headersTimeout: timeouts.headersMs,
          // A body may stream for as long as it needs (an upload through the
          // editor); the gate's own endpoints have their own deadline above.
          requestTimeout: 0,
          // How often Node enforces the headers deadline.
          connectionsCheckingInterval: Math.min(5_000, timeouts.headersMs),
          // Longer than the proxy's idle keep-alive (Caddy: 2 minutes), so the
          // proxy never reuses a connection the gate has just closed.
          keepAliveTimeout: 130_000,
        },
        (req, res) => {
          dispatch(req, res).catch((err: unknown) => {
            console.error("[gate] dispatch failed", err);
            if (!res.headersSent) plain(res, 500, "internal error");
            else res.destroy();
          });
        },
      );
      server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        upgrade(req, socket, head).catch((err: unknown) => {
          console.error("[gate] upgrade failed", err);
          socket.destroy();
        });
      });
      return server;
    },
  });
  await registerApi(app, core);
  await app.ready();

  const pruner = setInterval(() => {
    void auth.prune().catch(() => {});
    void devices.prune().catch(() => {});
  }, PRUNE_MS);
  pruner.unref();

  return {
    app,
    server: app.server,
    sandboxServer,
    core,
    apps: appGateway,
    authenticate: core.authenticate,
    close: async () => {
      clearInterval(pruner);
      appGateway.close();
      clientIps.stop();
      sandboxServer.closeAllConnections();
      if (sandboxServer.listening) await new Promise<void>((r) => sandboxServer.close(() => r()));
      await app.close();
      await store.flush();
    },
  };
}
