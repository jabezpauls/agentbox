import http from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream";
import { flatten, mayBeEditable, relayAppResponse } from "../app-access.js";
import {
  APP_SANDBOX,
  FONT_PATH,
  appOriginAllowed,
  appResponseHeaders,
  isFontType,
  isNullPreflight,
  preflightHeaders,
  type PolicyContext,
} from "../app-policy.js";
import { readCookie } from "../cookies.js";
import type { GateCore, RequestInfo } from "../context.js";
import { RESERVED, shimSource } from "../fidelity.js";
import { FRAME_ANCESTORS, SECURITY_HEADERS, filterResponseHeaders, forwardRequestHeaders, refuseUpgrade } from "../proxy.js";
import type { WindowLimiter } from "../ratelimit.js";
import {
  MACHINE_APP_COOKIE,
  MACHINE_GRANT_MS,
  machineGrantCookie,
  type MachineApp,
  type MachineAppGrants,
  type MachineApps,
  type MachineAppTickets,
} from "./apps.js";

/**
 * The machine-apps origin: `https://<machine-apps host>/<app id>/…`, an app a
 * machine's node registered (`agentbox-preview`), reached over the machine's
 * link — a stream whose open frame names the app's port, which the node
 * passes to that port on its loopback and nowhere else.
 *
 * Under the box's app policy, unchanged (app-policy.ts): every response in an
 * opaque origin (`APP_SANDBOX`), cookies rewritten to the app's path,
 * dangerous headers dropped, CORS answered for the app's own page alone, and
 * the path fixes for HTML and CSS (fidelity.ts). Framed by the machines
 * origin's Preview only. This hostname holds no session for anything else.
 *
 * Who may open an app: a grant cookie for it, minted when the owner opens it
 * from the machines page — which takes a single-use ticket bound to their
 * machines session (apps.ts) — and good only while that session lasts. A
 * font file is the one exception, as for the box's apps: `@font-face` loads
 * carry no cookie, so a GET of a font path is let through when what comes
 * back is a font. Anything else is a 404, from a per-address budget.
 *
 * Sharing an app publicly is not offered on machines yet.
 */

export const MACHINE_APP_PATH = /^\/([0-9a-f]{32})(\/.*)?$/;
const CONNECT_TIMEOUT_MS = 60_000;
const SWEEP_MS = 15_000;
const TOUCH_MS = 30_000;

interface Live {
  appId: string;
  session: string | null;
  close(): void;
}

export interface MachineAppGatewayDeps {
  core: GateCore;
  apps: MachineApps;
  tickets: MachineAppTickets;
  grants: MachineAppGrants;
  probes: WindowLimiter;
  /** `https://<machines host>`: the one origin that may frame an app. */
  machinesOrigin: string;
}

export class MachineAppGateway {
  private readonly live = new Map<string, Set<Live>>();
  /** A keep-alive pool of streams per machine: a dev server's hundred module requests ride a few. */
  private readonly agents = new Map<string, http.Agent>();
  private readonly touched = new Map<string, number>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly deps: MachineAppGatewayDeps) {
    deps.apps.onChange((c) => {
      for (const id of c.ids) this.cut(id, () => true);
    });
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  static match(path: string): { appId: string; rest: string } | null {
    const m = MACHINE_APP_PATH.exec(path);
    return m ? { appId: m[1] as string, rest: m[2] ?? "/" } : null;
  }

  // --- what is open, and cutting it ------------------------------------------------

  private track(entry: Live): () => void {
    let set = this.live.get(entry.appId);
    if (!set) this.live.set(entry.appId, (set = new Set()));
    set.add(entry);
    return () => {
      set.delete(entry);
      if (set.size === 0 && this.live.get(entry.appId) === set) this.live.delete(entry.appId);
    };
  }

  private cut(appId: string, which: (l: Live) => boolean): void {
    for (const l of [...(this.live.get(appId) ?? [])]) {
      if (!which(l)) continue;
      try {
        l.close();
      } catch {
        // already gone
      }
    }
  }

  private sweep(): void {
    const sessions = this.deps.core.machinesSessions;
    for (const id of [...this.live.keys()]) this.cut(id, (l) => l.session !== null && !sessions.liveById(l.session));
    const t = this.deps.core.now();
    for (const [k, at] of this.touched) if (t - at > TOUCH_MS * 4) this.touched.delete(k);
  }

  /** How many exchanges are open for an app (tests). */
  openCount(appId: string): number {
    return this.live.get(appId)?.size ?? 0;
  }

  // --- admission ---------------------------------------------------------------------

  private appFor(appId: string): MachineApp | null {
    const app = this.deps.apps.get(appId);
    if (!app) return null;
    const rec = this.deps.core.machines.registry.get(app.machineId);
    return rec && rec.state === "active" ? app : null;
  }

  /** The machines session a valid grant for this app names, with its expiry. */
  private granted(req: IncomingMessage, app: MachineApp): { session: string; expiresAt: number } | null {
    const value = readCookie(req.headers.cookie, MACHINE_APP_COOKIE);
    if (!value) return null;
    const g = this.deps.grants.verify(value, this.deps.core.now());
    if (!g || g.appId !== app.id || !this.deps.core.machinesSessions.liveById(g.session)) return null;
    return { session: g.session, expiresAt: g.expiresAt };
  }

  /** An app in use is use of the machines session that opened it. */
  private touch(session: string): void {
    const t = this.deps.core.now();
    if (t - (this.touched.get(session) ?? 0) < TOUCH_MS) return;
    this.touched.set(session, t);
    this.deps.core.machinesSessions.touch(session);
  }

  private plain(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
    const headers: Record<string, string> = {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": APP_SANDBOX,
      connection: "close",
      ...extra,
    };
    for (const [n, v] of SECURITY_HEADERS) headers[n] = v;
    res.writeHead(status, headers);
    res.end(`${text}\n`);
  }

  private refuse(res: ServerResponse, info: RequestInfo): void {
    const wait = this.deps.probes.take(info.key);
    if (wait !== null) return this.plain(res, 429, "too many requests for apps that are not there", { "retry-after": String(Math.ceil(wait / 1000)) });
    this.plain(res, 404, "not found (open machine apps from the machines page)");
  }

  private policy(app: MachineApp, req: IncomingMessage): PolicyContext {
    return { prefix: `/${app.id}`, port: app.port, origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined };
  }

  /** Only the machines page may frame it; the proxy's `frame-ancestors 'self'` would forbid that. */
  private framing(pairs: Array<[string, string]>): Array<[string, string]> {
    const out = pairs.filter(([n, v]) => !(n.toLowerCase() === "content-security-policy" && v === FRAME_ANCESTORS));
    out.push(["Content-Security-Policy", `frame-ancestors ${this.deps.machinesOrigin}`]);
    return out;
  }

  /** What the machine's app is sent: nothing of the browser's credentials or address, the gate's cookies stripped. */
  private requestHeaders(req: IncomingMessage, app: MachineApp, upgrade: boolean): OutgoingHttpHeaders {
    const h = forwardRequestHeaders(req, { clientIp: "", proto: "https", host: "" }, upgrade);
    delete h["x-forwarded-for"];
    delete h["x-forwarded-proto"];
    delete h["x-forwarded-host"];
    // As a dev server expects to be asked (Vite checks it): its own loopback name.
    h.host = `localhost:${app.port}`;
    return h;
  }

  private agentFor(machineId: string): http.Agent {
    let agent = this.agents.get(machineId);
    if (agent) return agent;
    agent = new http.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4 });
    const links = this.deps.core.machines.links;
    (agent as unknown as { createConnection: (o: http.ClientRequestArgs, cb: (err: Error | null, s?: Duplex) => void) => undefined }).createConnection = (o, cb) => {
      links.openStream(machineId, "http", { session: null, grant: null, app: Number(o.port) }).then(
        (s) => cb(null, s),
        (err: Error) => cb(err),
      );
      return undefined;
    };
    this.agents.set(machineId, agent);
    return agent;
  }

  /** A machine revoked, removed or gone offline: its pooled streams go with it. */
  dropMachine(machineId: string): void {
    this.agents.get(machineId)?.destroy();
    this.agents.delete(machineId);
  }

  // --- plain requests ---------------------------------------------------------------------

  async handle(req: IncomingMessage, res: ServerResponse, path: string, query: string | null, info: RequestInfo): Promise<void> {
    if (isNullPreflight(req.method, req.headers)) {
      const headers = preflightHeaders(req.headers);
      for (const [n, v] of SECURITY_HEADERS) headers[n] = v;
      res.writeHead(204, headers);
      res.end();
      return;
    }
    const m = MachineAppGateway.match(path);
    const app = m ? this.appFor(m.appId) : null;
    if (!m || !app) return this.refuse(res, info);
    if (m.rest === `${RESERVED}/enter` && (req.method === "GET" || req.method === "HEAD")) return this.enter(res, app, query, info);

    const grant = this.granted(req, app);
    if (!grant) {
      if (req.method === "GET" && FONT_PATH.test(m.rest)) return this.forward(req, res, app, m.rest, query, null, null, true);
      return this.refuse(res, info);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? "") && !appOriginAllowed(req.headers)) {
      return this.plain(res, 403, "request refused: it did not come from this app");
    }
    if (!this.deps.core.machines.links.isOnline(app.machineId)) return this.plain(res, 503, "the machine is offline");
    this.touch(grant.session);
    // In use, half gone: renewed, so it lasts as long as the app is in use (and its session) and no longer.
    let cookie: string | null = null;
    const now = this.deps.core.now();
    if (grant.expiresAt - now < MACHINE_GRANT_MS / 2) {
      cookie = machineGrantCookie(app.id, this.deps.grants.mint(app.id, grant.session, now + MACHINE_GRANT_MS), MACHINE_GRANT_MS);
    }
    if (m.rest === `${RESERVED}/shim.js` && (req.method === "GET" || req.method === "HEAD")) return this.shim(req, res, app, cookie);
    this.forward(req, res, app, m.rest, query, grant.session, cookie, false);
  }

  /** The machines page's ticket, taken for a grant; then the app's own root. */
  private enter(res: ServerResponse, app: MachineApp, query: string | null, info: RequestInfo): void {
    const ticket = new URLSearchParams(query ?? "").get("t") ?? "";
    const session = ticket ? this.deps.tickets.take(ticket, app.id) : null;
    if (session === null || !this.deps.core.machinesSessions.liveById(session)) {
      return this.plain(res, 403, "this link has expired: open the app again from the machines page");
    }
    const now = this.deps.core.now();
    const headers: Record<string, string> = {
      location: `/${app.id}/`,
      "set-cookie": machineGrantCookie(app.id, this.deps.grants.mint(app.id, session, now + MACHINE_GRANT_MS), MACHINE_GRANT_MS),
      "cache-control": "no-store",
      "content-security-policy": APP_SANDBOX,
    };
    for (const [n, v] of SECURITY_HEADERS) headers[n] = v;
    console.log(`[gate] machine app ${app.id} (port ${app.port}) opened from ${info.ip}`);
    res.writeHead(303, headers);
    res.end();
  }

  private shim(req: IncomingMessage, res: ServerResponse, app: MachineApp, cookie: string | null): void {
    const body = Buffer.from(shimSource(`/${app.id}`), "utf8");
    let pairs: Array<[string, string]> = [
      ["Content-Type", "text/javascript; charset=utf-8"],
      ["Content-Length", String(body.length)],
      ["Cache-Control", "no-cache"],
    ];
    pairs = appResponseHeaders(pairs, this.policy(app, req));
    for (const [n, v] of SECURITY_HEADERS) pairs.push([n, v]);
    if (cookie) pairs.push(["Set-Cookie", cookie]);
    res.writeHead(200, flatten(pairs));
    res.end(req.method === "HEAD" ? undefined : body);
  }

  private forward(
    req: IncomingMessage,
    res: ServerResponse,
    app: MachineApp,
    rest: string,
    query: string | null,
    session: string | null,
    cookie: string | null,
    fontOnly: boolean,
  ): void {
    const headers = this.requestHeaders(req, app, false);
    const edit = !fontOnly;
    if (edit && mayBeEditable(req)) headers["accept-encoding"] = "identity";
    const upReq = http.request({
      host: "machine",
      port: app.port,
      method: req.method,
      path: `${rest}${query === null ? "" : `?${query}`}`,
      headers,
      agent: this.agentFor(app.machineId),
    });
    const untrack = this.track({
      appId: app.id,
      session,
      close: () => {
        upReq.destroy();
        res.destroy();
      },
    });
    res.once("close", () => {
      untrack();
      if (!res.writableFinished) upReq.destroy();
    });
    const connectTimer = setTimeout(() => upReq.destroy(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
    upReq.once("socket", () => clearTimeout(connectTimer));
    upReq.on("response", (upRes) => {
      clearTimeout(connectTimer);
      if (fontOnly && !isFontType(upRes.headers["content-type"])) {
        upRes.resume();
        return this.plain(res, 404, "not found");
      }
      const pairs = this.framing(appResponseHeaders(filterResponseHeaders(upRes), this.policy(app, req)));
      if (cookie) pairs.push(["Set-Cookie", cookie]);
      relayAppResponse(req, res, upRes, pairs, { edit, prefix: `/${app.id}` });
    });
    upReq.on("error", (err: Error & { status?: number }) => {
      clearTimeout(connectTimer);
      if (res.headersSent) return void res.destroy();
      this.plain(res, typeof err.status === "number" ? err.status : 502, "the app on the machine is not answering");
    });
    pipeline(req, upReq, () => {});
  }

  // --- WebSockets ---------------------------------------------------------------------------

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, path: string, query: string | null, info: RequestInfo): void {
    const m = MachineAppGateway.match(path);
    const app = m ? this.appFor(m.appId) : null;
    const grant = app ? this.granted(req, app) : null;
    if (!m || !app || !grant) {
      const wait = this.deps.probes.take(info.key);
      return refuseUpgrade(socket, wait === null ? 404 : 429, wait === null ? "Not Found" : "Too Many Requests");
    }
    if (!appOriginAllowed(req.headers)) return refuseUpgrade(socket, 403, "Forbidden");
    if (!this.deps.core.machines.links.isOnline(app.machineId)) return refuseUpgrade(socket, 503, "Service Unavailable");
    this.touch(grant.session);
    const untrack = this.track({ appId: app.id, session: grant.session, close: () => socket.destroy() });
    socket.once("close", untrack);

    const ctx = this.policy(app, req);
    const links = this.deps.core.machines.links;
    const upReq = http.request({
      method: req.method,
      path: `${m.rest}${query === null ? "" : `?${query}`}`,
      headers: this.requestHeaders(req, app, true),
      createConnection: (_o, oncreate) => {
        links.openStream(app.machineId, "upgrade", { session: null, grant: null, app: app.port }).then(
          (s) => oncreate(null, s),
          (err: Error) => oncreate(err, undefined as unknown as Duplex),
        );
        return undefined;
      },
    });
    const connectTimer = setTimeout(() => upReq.destroy(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
    let upgraded = false;
    upReq.on("upgrade", (upRes, upSocket, upHead) => {
      clearTimeout(connectTimer);
      upgraded = true;
      if (socket.destroyed) return void upSocket.destroy();
      const pairs = appResponseHeaders(filterResponseHeaders(upRes, true), ctx).filter(([n]) => n.toLowerCase() !== "content-security-policy");
      let block = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || "Switching Protocols"}\r\n`;
      for (const [n, v] of pairs) block += `${n}: ${v}\r\n`;
      socket.write(`${block}\r\n`);
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      const end = (): void => {
        socket.destroy();
        upSocket.destroy();
      };
      upSocket.on("error", end);
      socket.on("error", end);
      upSocket.on("close", end);
      socket.on("close", end);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    upReq.on("response", (upRes) => {
      clearTimeout(connectTimer);
      const pairs = this.framing(appResponseHeaders(filterResponseHeaders(upRes), ctx));
      pairs.push(["Connection", "close"]);
      let block = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || ""}\r\n`;
      for (const [n, v] of pairs) block += `${n}: ${v}\r\n`;
      socket.write(`${block}\r\n`);
      pipeline(upRes, socket, () => {});
    });
    upReq.on("error", () => {
      clearTimeout(connectTimer);
      refuseUpgrade(socket, 502, "Bad Gateway");
    });
    const abandon = (): void => {
      if (!upgraded) upReq.destroy();
    };
    socket.on("error", abandon);
    socket.on("close", abandon);
    upReq.end();
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const a of this.agents.values()) a.destroy();
    this.agents.clear();
    for (const id of [...this.live.keys()]) this.cut(id, () => true);
  }
}

/** The refusal headers for the machine-apps origin, before routing (app.ts). */
export function machineAppsRefusal(res: ServerResponse, status: number, text: string): void {
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": APP_SANDBOX,
    connection: "close",
  };
  for (const [n, v] of SECURITY_HEADERS) headers[n] = v;
  res.writeHead(status, headers);
  res.end(`${text}\n`);
}
