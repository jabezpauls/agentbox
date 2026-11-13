import http from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { GateCore, RequestInfo } from "../context.js";
import { proxyHttp, proxyUpgrade, refuseUpgrade, type Forwarded, type ProxyOptions } from "../proxy.js";
import { machinesHeaderLines } from "./headers.js";
import { StreamRefused, type StreamKind } from "./link.js";
import { machineResponseHeaders } from "./respond.js";

/**
 * `/m/<machine id>/…` on the machines origin: a machine's own HTTP server —
 * its herdr RPC, terminal and events sockets — reached over its link. The
 * gate's existing proxyHttp / proxyUpgrade do the forwarding, over a dialer
 * that opens a stream on the link instead of a TCP connection.
 *
 * - A machines session is required (its cookie and nothing else); the
 *   machines origin's request rules were applied before this runs (app.ts).
 * - The stream's open frame tells the node which machines session asks and
 *   the presence grant the node issued it, which the gate holds (below) and
 *   the node checks: without a live grant the node opens no terminal, agents
 *   or files.
 * - Nothing of the browser's credentials reaches the machine: no cookie, no
 *   Authorization, no forwarding headers.
 * - The machine's response headers are rebuilt (respond.ts); an HTML body or
 *   a redirect becomes a 502.
 */

export const MACHINE_PATH = /^\/m\/([0-9a-f]{24})(\/.*)?$/;

/** Ask a machine's server for this long at most, when the gate itself asks (presence). */
const ASK_MS = 15_000;
const ASK_MAX_BYTES = 16 * 1024;
/** How often WebSockets to machines are checked against their session. */
const SWEEP_MS = 15_000;

interface HeldGrant {
  grant: string;
  expiresAt: number;
}

export class MachineRouter {
  /** Presence grants the machines issued, by machines session and machine. */
  private readonly grants = new Map<string, HeldGrant>();
  /** WebSockets open to machines, by the machines session that opened them. */
  private readonly sockets = new Map<string, Set<Duplex>>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly core: GateCore) {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  static match(path: string): { machineId: string; rest: string } | null {
    const m = MACHINE_PATH.exec(path);
    return m ? { machineId: m[1] as string, rest: m[2] ?? "/" } : null;
  }

  private key(sessionId: string, machineId: string): string {
    return `${sessionId}\n${machineId}`;
  }

  grantFor(sessionId: string, machineId: string): string | null {
    const k = this.key(sessionId, machineId);
    const g = this.grants.get(k);
    if (!g) return null;
    if (g.expiresAt <= this.core.now()) {
      this.grants.delete(k);
      return null;
    }
    return g.grant;
  }

  grantExpiry(sessionId: string, machineId: string): number | null {
    return this.grantFor(sessionId, machineId) ? (this.grants.get(this.key(sessionId, machineId)) as HeldGrant).expiresAt : null;
  }

  setGrant(sessionId: string, machineId: string, grant: string, expiresAt: number): void {
    this.grants.set(this.key(sessionId, machineId), { grant, expiresAt });
  }

  /** A machine revoked or removed: what was granted for it, and what it has open, ends. */
  forget(machineId: string): void {
    for (const k of [...this.grants.keys()]) if (k.endsWith(`\n${machineId}`)) this.grants.delete(k);
  }

  private sweep(): void {
    for (const [id, set] of this.sockets) {
      if (this.core.machinesSessions.liveById(id)) continue;
      for (const s of set) s.destroy();
      this.sockets.delete(id);
    }
    const t = this.core.now();
    for (const [k, g] of this.grants) if (g.expiresAt <= t) this.grants.delete(k);
  }

  private track(sessionId: string, socket: Duplex): void {
    let set = this.sockets.get(sessionId);
    if (!set) this.sockets.set(sessionId, (set = new Set()));
    set.add(socket);
    socket.once("close", () => {
      set.delete(socket);
      if (set.size === 0 && this.sockets.get(sessionId) === set) this.sockets.delete(sessionId);
    });
  }

  private dialer(machineId: string, kind: StreamKind, sessionId: string): NonNullable<ProxyOptions["dial"]> {
    return (cb) => {
      this.core.machines.links
        .openStream(machineId, kind, { session: sessionId, grant: this.grantFor(sessionId, machineId) })
        .then((s) => cb(null, s), (err: Error) => cb(err));
    };
  }

  /** Why this request may not reach the machine, or the session it is for. */
  private admit(req: IncomingMessage, machineId: string, info: RequestInfo): { status: number; message: string } | { sessionId: string } {
    if (req.headers.authorization !== undefined) return { status: 401, message: "the machines origin takes its own sign-in only" };
    const session = this.core.machinesSessions.authenticate(req.headers.cookie, info.ip);
    if (!session) return { status: 401, message: "sign in to machines first" };
    const rec = this.core.machines.registry.get(machineId);
    if (!rec || rec.state !== "active") return { status: 404, message: "no such machine" };
    if (!this.core.machines.links.isOnline(machineId)) return { status: 503, message: "machine offline" };
    return { sessionId: session.id };
  }

  private options(target: string, info: RequestInfo, machineId: string, kind: StreamKind, sessionId: string): ProxyOptions {
    const forwarded: Forwarded = { clientIp: info.ip, proto: info.proto, host: info.host };
    return {
      target,
      forwarded,
      dial: this.dialer(machineId, kind, sessionId),
      // The machine learns nothing of the browser's credentials or address.
      requestHeaders: (h: OutgoingHttpHeaders) => {
        const out = { ...h };
        for (const n of ["cookie", "authorization", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host"]) delete out[n];
        return out;
      },
      rebuildResponse: machineResponseHeaders,
      refusalHeaderLines: machinesHeaderLines(),
    };
  }

  http(req: IncomingMessage, res: ServerResponse, machineId: string, rest: string, query: string | null, info: RequestInfo): void {
    const ok = this.admit(req, machineId, info);
    if ("status" in ok) {
      res.writeHead(ok.status, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: ok.status === 401 ? "unauthorized" : ok.status === 404 ? "not_found" : "offline", message: ok.message }));
      return;
    }
    const target = query === null ? rest : `${rest}?${query}`;
    proxyHttp({ host: "", port: 0 }, req, res, this.options(target, info, machineId, "http", ok.sessionId));
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, machineId: string, rest: string, query: string | null, info: RequestInfo): void {
    const ok = this.admit(req, machineId, info);
    if ("status" in ok) return refuseUpgrade(socket, ok.status, http.STATUS_CODES[ok.status] ?? "Refused", machinesHeaderLines());
    const sessionId = ok.sessionId;
    this.track(sessionId, socket);
    let last = 0;
    const target = query === null ? rest : `${rest}?${query}`;
    proxyUpgrade({ host: "", port: 0 }, req, socket, head, {
      ...this.options(target, info, machineId, "upgrade", sessionId),
      // A terminal in use is use of the machines session.
      onClientData: () => {
        const t = this.core.now();
        if (t - last < 30_000) return;
        last = t;
        this.core.machinesSessions.touch(sessionId);
      },
    });
  }

  /**
   * The gate itself asking a machine's server (presence): one request over a
   * stream for this session, its JSON answer. Throws StreamRefused when the
   * machine cannot be reached.
   */
  ask(machineId: string, sessionId: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          method,
          path,
          headers: { host: "machine", ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}) },
          createConnection: (_o, oncreate) => {
            this.core.machines.links.openStream(machineId, "http", { session: sessionId, grant: null }).then(
              (s) => oncreate(null, s),
              (err: Error) => oncreate(err, undefined as unknown as Duplex),
            );
            return undefined;
          },
          timeout: ASK_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > ASK_MAX_BYTES) return req.destroy(new StreamRefused("the machine's answer is too large", 502));
            chunks.push(c);
          });
          res.on("end", () => {
            let json: unknown = null;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              // Not JSON: an empty object, below.
            }
            resolve({ status: res.statusCode ?? 502, json: typeof json === "object" && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : {} });
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new StreamRefused("the machine did not answer in time", 504)));
      req.on("error", reject);
      req.end(payload);
    });
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const set of this.sockets.values()) for (const s of set) s.destroy();
    this.sockets.clear();
    this.grants.clear();
  }
}
