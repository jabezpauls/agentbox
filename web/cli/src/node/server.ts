import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { heartbeat, HerdrError, isAllowed, request, serveTerminalSocket, type SessionHub, type TerminalStreams } from "@workbench/hostcore/herdr";
import type { StreamOpen } from "@workbench/hostcore/link";
import type { LoadedPolicy } from "./policy.js";
import type { PresenceGate } from "./presence.js";

/**
 * The node's HTTP server. It listens on no port: the link hands it each
 * stream the gate opens (`accept`), with what the stream's open frame said —
 * which machines session asks, and the presence grant this machine issued
 * it. It serves the bridge's own API shapes, so the Workbench's components
 * work against `/m/<machine id>` with only their base changed:
 *
 *   GET  /api/health                     herdr's state (ungated)
 *   POST /presence/challenge             a challenge and the salt (ungated)
 *   POST /presence/answer                an answer, for a grant (ungated)
 *   GET  /api/session                    herdr's snapshot          ┐
 *   POST /api/rpc                        herdr RPC, allowlisted     │ `terminals` on,
 *   WS   /ws/events                      snapshot, then live events │ and a live grant
 *   WS   /ws/terminal                    pane streams               ┘
 *
 * Every channel opened is tracked with its grant: when the policy tightens,
 * or a grant ends, `enforce` closes what is no longer allowed (run.ts calls
 * it on every policy change and every few seconds).
 *
 * A route for later phases (Files, Preview) is one more entry in `routes`
 * with its own policy check; `channel` tracks it the same way.
 */

export interface NodeServerOptions {
  /** herdr's control socket now (a fresh random path at each herdr start). */
  herdrSocket: () => string | null;
  hub: () => SessionHub | null;
  streams: () => TerminalStreams | null;
  policy: () => LoadedPolicy;
  presence: PresenceGate;
  home: string;
  log?: (line: string) => void;
}

/** What a channel needs to be allowed: herdr's (terminals, agents). */
type Need = "terminals";

interface Channel {
  need: Need;
  open: StreamOpen;
  close: () => void;
}

const MAX_BODY = 64 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
        resolve(typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function refuseSocket(socket: Duplex, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
  );
}

export class NodeServer {
  readonly server: http.Server;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly opens = new WeakMap<Duplex, StreamOpen>();
  private readonly channels = new Set<Channel>();

  constructor(private readonly o: NodeServerOptions) {
    this.server = http.createServer({ requestTimeout: 0, headersTimeout: 30_000, keepAliveTimeout: 60_000 }, (req, res) => {
      void this.handle(req, res).catch((err: unknown) => {
        o.log?.(`server: ${(err as Error).message}`);
        if (!res.headersSent) json(res, 500, { error: "internal" });
        else res.destroy();
      });
    });
    this.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head));
    this.server.on("clientError", (_err, socket: Duplex) => socket.destroy());
  }

  /** A stream from the link: a connection to this server. */
  accept(stream: Duplex, open: StreamOpen): void {
    this.opens.set(stream, open);
    this.server.emit("connection", stream);
  }

  private openOf(req: IncomingMessage): StreamOpen {
    return this.opens.get(req.socket) ?? { kind: "http", session: null, grant: null };
  }

  /** Why `need` is not allowed for this stream now, or `null`. */
  private refusal(need: Need, open: StreamOpen): { status: number; body: { error: string; message: string } } | null {
    const l = this.o.policy();
    if (need === "terminals" && !l.policy.terminals) {
      return {
        status: 403,
        body: { error: "terminals_off", message: l.problem ? `this machine's policy denies everything: ${l.problem}` : "terminals are off in this machine's policy.json" },
      };
    }
    if (!this.o.presence.check(open.grant, open.session)) {
      return { status: 401, body: { error: "presence", message: "this machine wants proof that you are there: the machines passphrase" } };
    }
    return null;
  }

  /** Close every channel the policy or presence no longer allows. Returns how many. */
  enforce(): number {
    let n = 0;
    for (const ch of [...this.channels]) {
      if (this.refusal(ch.need, ch.open) === null) continue;
      this.channels.delete(ch);
      ch.close();
      n += 1;
    }
    return n;
  }

  /** Track a channel for as long as `until` lasts; holds its grant from idling out. */
  private channel(need: Need, open: StreamOpen, close: () => void, onEnd: (cb: () => void) => void): void {
    const ch: Channel = { need, open, close };
    this.channels.add(ch);
    const release = open.grant ? this.o.presence.hold(open.grant) : () => {};
    onEnd(() => {
      this.channels.delete(ch);
      release();
    });
  }

  get openChannels(): number {
    return this.channels.size;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://machine");
    const open = this.openOf(req);
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/health": {
        const hub = this.o.hub();
        const l = this.o.policy();
        return json(res, 200, {
          ok: true,
          herdr: { connected: hub?.connected ?? false, version: hub?.version ?? null, protocol: hub?.protocol ?? null },
          workspaceRoot: this.o.home,
          homeRoot: this.o.home,
          sharing: false,
          publicUrl: null,
          machine: { terminals: l.policy.terminals, problem: l.problem, presenceLocked: this.o.presence.locked() },
        });
      }
      case "POST /presence/challenge": {
        await readJson(req);
        const c = this.o.presence.challenge(open.session);
        if (c === null) return json(res, 400, { error: "no_session", message: "no machines session" });
        if ("locked" in c) return json(res, 429, { error: "locked", until: c.until, message: lockedMessage(c.until) });
        return json(res, 200, c);
      }
      case "POST /presence/answer": {
        const b = await readJson(req);
        const r = this.o.presence.answer(open.session, typeof b?.challenge === "string" ? b.challenge : "", typeof b?.answer === "string" ? b.answer : "");
        if (r.ok) return json(res, 200, { grant: r.grant, expiresAt: r.expiresAt });
        if (r.error === "locked") return json(res, 429, { error: "locked", until: r.until, message: lockedMessage(r.until) });
        if (r.error === "wrong") return json(res, 401, { error: "wrong", message: "That is not this machine's passphrase.", failures: r.failures });
        return json(res, 400, { error: r.error, message: "That challenge has expired; try again." });
      }
      case "GET /api/session":
      case "POST /api/rpc": {
        const no = this.refusal("terminals", open);
        if (no) return json(res, no.status, no.body);
        const socket = this.o.herdrSocket();
        if (!socket) return json(res, 503, { error: "herdr", message: "herdr is starting on this machine" });
        this.channel(
          "terminals",
          open,
          () => res.destroy(),
          (cb) => res.once("close", cb),
        );
        if (route === "GET /api/session") {
          const hub = this.o.hub();
          if (!hub) return json(res, 503, { error: "herdr", message: "herdr is starting on this machine" });
          try {
            return json(res, 200, await hub.snapshot());
          } catch (err) {
            return json(res, 502, { error: "herdr", message: (err as Error).message });
          }
        }
        const b = await readJson(req);
        const method = b?.method;
        if (typeof method !== "string") return json(res, 400, { error: "method required" });
        if (!isAllowed(method)) return json(res, 403, { error: "method not allowed" });
        const params = typeof b?.params === "object" && b.params !== null ? (b.params as Record<string, unknown>) : {};
        try {
          return json(res, 200, { result: await request(socket, method, params) });
        } catch (err) {
          if (err instanceof HerdrError) return json(res, 502, { error: { code: err.code, message: err.message } });
          return json(res, 502, { error: { code: "unreachable", message: (err as Error).message } });
        }
      }
      default:
        return json(res, 404, { error: "not found" });
    }
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    const url = new URL(req.url ?? "/", "http://machine");
    const open = this.openOf(req);
    if (url.pathname !== "/ws/terminal" && url.pathname !== "/ws/events") return refuseSocket(socket, 404, { error: "not found" });
    const no = this.refusal("terminals", open);
    if (no) return refuseSocket(socket, no.status, no.body);
    const streams = this.o.streams();
    const hub = this.o.hub();
    if (!streams || !hub) return refuseSocket(socket, 503, { error: "herdr", message: "herdr is starting on this machine" });
    this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      this.channel(
        "terminals",
        open,
        () => ws.terminate(),
        (cb) => ws.once("close", cb),
      );
      if (url.pathname === "/ws/terminal") {
        serveTerminalSocket(ws, streams, { pane: url.searchParams.get("pane") ?? undefined, cols: url.searchParams.get("cols") ?? undefined, rows: url.searchParams.get("rows") ?? undefined });
        return;
      }
      this.events(ws, hub);
    });
  }

  /** `/ws/events`: a fresh snapshot, then every hub message as it comes. */
  private events(ws: WebSocket, hub: SessionHub): void {
    heartbeat(ws);
    let off: (() => void) | null = null;
    const send = (m: unknown): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    hub.snapshot().then(
      (snapshot) => {
        if (ws.readyState !== ws.OPEN) return;
        send({ kind: "snapshot", snapshot });
        off = hub.on(send);
      },
      () => ws.close(),
    );
    ws.on("close", () => off?.());
  }

  close(): void {
    for (const ch of [...this.channels]) ch.close();
    this.channels.clear();
    this.wss.close();
    this.server.close();
  }
}

function lockedMessage(until: number): string {
  const mins = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  return `Too many wrong passphrases: this machine has locked presence for ${mins} more minute${mins === 1 ? "" : "s"}.`;
}
