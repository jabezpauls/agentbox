import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { registerApi } from "./api.js";
import { Auth, type Subject } from "./auth.js";
import { ClientIpResolver, normalizeIp } from "./client-ip.js";
import type { Config } from "./config.js";
import { peekInfo, setInfo, type GateCore, type RequestInfo } from "./context.js";
import { DeviceFlow } from "./device.js";
import { isSafeMethod, isSameOriginRequest, originMatchesHost } from "./origin.js";
import { PasswordChecker } from "./password.js";
import { isRoutablePath, splitTarget } from "./path-guard.js";
import { proxyHttp, proxyUpgrade, refuseUpgrade, SECURITY_HEADERS, type Forwarded } from "./proxy.js";
import { LOGIN_LIMITS, LoginLimiter, WindowLimiter, type LoginLimits } from "./ratelimit.js";
import { route } from "./routes.js";
import { Store } from "./store.js";

/**
 * The gate: every request to the box passes through here.
 *
 * A raw `http.Server` does the dispatching, in this order, for plain requests
 * and WebSocket upgrades alike:
 *
 * 1. the path guard refuses (400) any raw path two parsers could read
 *    differently, before anything else looks at it;
 * 2. the client's address is settled (forwarding headers count only from the
 *    proxy);
 * 3. the route table picks the destination from the raw path;
 * 4. the gate's own paths go to Fastify; everything else needs a session or a
 *    device token, passes the same-origin checks, and is forwarded with every
 *    front-door credential stripped.
 *
 * Proxied traffic never touches Fastify, so no body parser, router quirk or
 * length limit of Fastify's stands between a request and its upstream.
 */

export interface GateDeps {
  now?: () => number;
  limits?: LoginLimits;
  /** DNS for the trusted proxy's name; tests substitute their own. */
  lookup?: (host: string) => Promise<string[]>;
}

export interface Gate {
  app: FastifyInstance;
  server: http.Server;
  core: GateCore;
  /** The session or device token a request carries, if any. */
  authenticate(req: IncomingMessage): Subject | null;
  close(): Promise<void>;
}

/** Periodic cleanup of expired sessions and device logins. */
const PRUNE_MS = 10 * 60_000;

function plain(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra };
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

export async function buildGate(config: Config, deps: GateDeps = {}): Promise<Gate> {
  const now = deps.now ?? Date.now;
  const store = await Store.open(config.dataDir, config.seedPasswordHash, now());
  const auth = new Auth(store, now);
  const devices = new DeviceFlow(store, auth, now);
  const clientIps = new ClientIpResolver(config.trustedProxies, config.clientIpHeader, deps.lookup, now);

  const core: GateCore = {
    config,
    store,
    auth,
    devices,
    limiter: new LoginLimiter(deps.limits ?? LOGIN_LIMITS, now),
    deviceStarts: new WindowLimiter(10, 60_000, now),
    devicePolls: new WindowLimiter(60, 60_000, now),
    totpConfirms: new WindowLimiter(10, 60_000, now),
    passwords: new PasswordChecker(config.bcryptCost),
    now,
    authenticate: (req) => auth.authenticate(req, peekInfo(req)?.ip ?? normalizeIp(req.socket.remoteAddress ?? "")),
  };

  async function settle(req: IncomingMessage): Promise<RequestInfo> {
    const who = await clientIps.resolve(req);
    const claimedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
    const info: RequestInfo = {
      ip: who.ip,
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

  let fastifyHandler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { path, query } = splitTarget(req.url ?? "");
    if (!isRoutablePath(path)) {
      plain(res, 400, "bad path");
      return;
    }
    const info = await settle(req);
    const r = route(path, query);

    if (r.kind === "gate") {
      (fastifyHandler as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
      return;
    }
    if (r.kind === "redirect") {
      plain(res, 308, "moved", { location: r.location });
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
    proxyHttp(config.upstreams[r.upstream], req, res, { target: r.target, forwarded: forwarded(info) });
  }

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on("error", () => socket.destroy());
    const { path, query } = splitTarget(req.url ?? "");
    if (!isRoutablePath(path)) return refuseUpgrade(socket, 400, "Bad Request");
    const info = await settle(req);
    const r = route(path, query);
    // The gate's own routes take no upgrades (yet); nor does a redirect.
    if (r.kind !== "upstream") return refuseUpgrade(socket, 404, "Not Found");
    const subject = core.authenticate(req);
    if (!subject) return refuseUpgrade(socket, 401, "Unauthorized");
    // A WebSocket handshake is not covered by the same-origin policy: without
    // this, any page in another tab could open a terminal on the session
    // cookie. A device token is not ambient, so it needs no such check.
    if (subject.kind === "session" && !originMatchesHost(req.headers)) return refuseUpgrade(socket, 403, "Forbidden");
    proxyUpgrade(config.upstreams[r.upstream], req, socket, head, { target: r.target, forwarded: forwarded(info) });
  }

  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    serverFactory: (handler) => {
      fastifyHandler = handler;
      const server = http.createServer((req, res) => {
        dispatch(req, res).catch((err: unknown) => {
          console.error("[gate] dispatch failed", err);
          if (!res.headersSent) plain(res, 500, "internal error");
          else res.destroy();
        });
      });
      server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        upgrade(req, socket, head).catch((err: unknown) => {
          console.error("[gate] upgrade failed", err);
          socket.destroy();
        });
      });
      // A body may stream for as long as it needs (an upload through the
      // editor); only the headers are held to a deadline.
      server.requestTimeout = 0;
      // Longer than the proxy's idle keep-alive (Caddy: 2 minutes), so the
      // proxy never reuses a connection the gate has just closed.
      server.keepAliveTimeout = 130_000;
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
    core,
    authenticate: core.authenticate,
    close: async () => {
      clearInterval(pruner);
      await app.close();
      await store.flush();
    },
  };
}
