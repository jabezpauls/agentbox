import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { serveFiles, type FilesService } from "@workbench/hostcore/files";
import { heartbeat, HerdrError, isAllowed, request, serveTerminalSocket, type SessionHub, type TerminalStreams } from "@workbench/hostcore/herdr";
import type { StreamOpen } from "@workbench/hostcore/link";
import type { LoadedPolicy } from "./policy.js";
import type { PresenceGate } from "./presence.js";
import { toApiPath } from "./files.js";
import { connectLocal, type Previews } from "./preview.js";

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
 *   *    /api/files/…                    the files API (files/http.ts in hostcore): a folder
 *                                        in the policy's `files`, and a live grant
 *
 * A stream the gate opens for an app (its open frame names a registered
 * port) goes to a second server, which passes every request on it to that
 * port on this machine's loopback (127.0.0.1, then [::1]) and nothing else,
 * while `ports` is on; apps need no presence (the gate admits them on the
 * machine-apps origin). Nothing else of the node is reachable on such a
 * stream, and no other stream reaches an app.
 *
 * Every channel opened is tracked with its grant: when the policy tightens,
 * or a grant ends, `enforce` closes what is no longer allowed (run.ts calls
 * it on every policy change and every few seconds).
 *
 * A files request is tracked too, and closed when the policy's folders
 * change at all (a folder made read-only mid-upload, say); an app's, when
 * its registration ends.
 */

export interface NodeServerOptions {
  /** herdr's control socket now (a fresh random path at each herdr start). */
  herdrSocket: () => string | null;
  hub: () => SessionHub | null;
  streams: () => TerminalStreams | null;
  policy: () => LoadedPolicy;
  presence: PresenceGate;
  home: string;
  /** The files service for the policy's folders now; `null` when it allows none. */
  files?: () => FilesService | null;
  previews?: Previews;
  log?: (line: string) => void;
}

/** What a channel needs to be allowed: herdr's (terminals, agents), the files API, an app. */
type Need = "terminals" | "files" | "ports";

interface Channel {
  need: Need;
  open: StreamOpen;
  close: () => void;
  /** Still what it was opened under (the same folders; the app still registered). */
  still?: () => boolean;
}

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

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
  /** Streams for an app: every request on one goes to its registered port. */
  readonly appServer: http.Server;
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
    this.appServer = http.createServer({ requestTimeout: 0, headersTimeout: 30_000, keepAliveTimeout: 60_000 }, (req, res) => this.app(req, res));
    this.appServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => this.appUpgrade(req, socket, head));
    this.appServer.on("clientError", (_err, socket: Duplex) => socket.destroy());
  }

  /** A stream from the link: a connection to this server (or, for an app, to the app's). */
  accept(stream: Duplex, open: StreamOpen): void {
    this.opens.set(stream, open);
    (open.app === undefined ? this.server : this.appServer).emit("connection", stream);
  }

  private openOf(req: IncomingMessage): StreamOpen {
    return this.opens.get(req.socket) ?? { kind: "http", session: null, grant: null };
  }

  /** Why `need` is not allowed for this stream now, or `null`. */
  private refusal(need: Need, open: StreamOpen): { status: number; body: { error: string; message: string } } | null {
    const l = this.o.policy();
    const denied = (error: string, what: string) => ({
      status: 403,
      body: { error, message: l.problem ? `this machine's policy denies everything: ${l.problem}` : what },
    });
    if (need === "terminals" && !l.policy.terminals) return denied("terminals_off", "terminals are off in this machine's policy.json");
    if (need === "files" && l.policy.files.length === 0) return denied("files_off", "this machine's policy.json allows no folders");
    if (need === "ports") {
      if (!l.policy.ports) return denied("ports_off", "apps are off in this machine's policy.json (ports)");
      // An app is admitted by the gate on the machine-apps origin, not by presence.
      return null;
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
      if (this.refusal(ch.need, ch.open) === null && (ch.still?.() ?? true)) continue;
      this.channels.delete(ch);
      ch.close();
      n += 1;
    }
    return n;
  }

  /** Track a channel for as long as `until` lasts; holds its grant from idling out. */
  private channel(need: Need, open: StreamOpen, close: () => void, onEnd: (cb: () => void) => void, still?: () => boolean): void {
    const ch: Channel = still ? { need, open, close, still } : { need, open, close };
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
          machine: {
            terminals: l.policy.terminals,
            files: l.policy.files.map((f) => ({ path: toApiPath(f.path), mode: f.mode })),
            ports: l.policy.ports,
            problem: l.problem,
            presenceLocked: this.o.presence.locked(),
          },
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
      default: {
        if (url.pathname === "/api/files" || url.pathname.startsWith("/api/files/")) return this.files(req, res, open);
        return json(res, 404, { error: "not found" });
      }
    }
  }

  private async files(req: IncomingMessage, res: ServerResponse, open: StreamOpen): Promise<void> {
    const no = this.refusal("files", open);
    if (no) {
      req.resume();
      return json(res, no.status, no.body);
    }
    const svc = this.o.files?.() ?? null;
    if (!svc) return json(res, 403, { error: "files_off", message: "this machine's policy.json allows no folders" });
    this.channel(
      "files",
      open,
      () => res.destroy(),
      (cb) => res.once("close", cb),
      () => this.o.files?.() === svc,
    );
    await serveFiles(svc, req, res);
  }

  /** The port an app stream is for, if it may be served now; else the refusal to send. */
  private appPort(open: StreamOpen): { port: number } | { status: number; body: unknown } {
    const no = this.refusal("ports", open);
    if (no) return no;
    const port = open.app;
    if (port === undefined || !this.o.previews?.has(port)) return { status: 404, body: { error: "not_found", message: "no app is registered on that port here" } };
    return { port };
  }

  /** A request for an app: passed on to its port as it came, its answer back as it comes (the gate applies the app policy). */
  private app(req: IncomingMessage, res: ServerResponse): void {
    const open = this.openOf(req);
    const p = this.appPort(open);
    if (!("port" in p)) {
      req.resume();
      return json(res, p.status, p.body);
    }
    const { port } = p;
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k)) headers[k] = v;
    if (req.headers["transfer-encoding"] !== undefined && req.headers["content-length"] === undefined) headers["transfer-encoding"] = "chunked";
    connectLocal(port).then(
      (sock) => {
        if (res.destroyed) return void sock.destroy();
        const up = http.request({ method: req.method, path: req.url ?? "/", headers, createConnection: () => sock }, (upRes) => {
          const raw: string[] = [];
          for (let i = 0; i + 1 < upRes.rawHeaders.length; i += 2) {
            if (HOP.has((upRes.rawHeaders[i] as string).toLowerCase())) continue;
            raw.push(upRes.rawHeaders[i] as string, upRes.rawHeaders[i + 1] as string);
          }
          // Never followed: a redirect goes back as it is, for the gate to keep inside the app.
          res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, raw);
          upRes.pipe(res);
          upRes.on("error", () => res.destroy());
        });
        up.on("error", () => (res.headersSent ? res.destroy() : json(res, 502, { error: "app", message: `the app on port ${port} did not answer` })));
        res.once("close", () => {
          if (!res.writableFinished) up.destroy();
        });
        this.channel("ports", open, () => res.destroy(), (cb) => res.once("close", cb), () => this.o.previews?.has(port) ?? false);
        req.pipe(up);
      },
      () => {
        req.resume();
        json(res, 502, { error: "app", message: `nothing answers on port ${port} here` });
      },
    );
  }

  /** An app's WebSocket (or any upgrade): its request head to the port, then bytes both ways. */
  private appUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    const open = this.openOf(req);
    const p = this.appPort(open);
    if (!("port" in p)) return refuseSocket(socket, p.status, p.body);
    const { port } = p;
    connectLocal(port).then(
      (up) => {
        if (socket.destroyed) return void up.destroy();
        let block = `${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1\r\n`;
        for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) block += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        up.write(`${block}\r\n`);
        if (head.length) up.write(head);
        const end = (): void => {
          up.destroy();
          socket.destroy();
        };
        up.on("error", end);
        up.on("close", end);
        socket.on("close", end);
        this.channel("ports", open, end, (cb) => socket.once("close", cb), () => this.o.previews?.has(port) ?? false);
        up.pipe(socket);
        socket.pipe(up);
      },
      () => refuseSocket(socket, 502, { error: "app", message: `nothing answers on port ${port} here` }),
    );
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
    this.appServer.close();
  }
}

function lockedMessage(until: number): string {
  const mins = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  return `Too many wrong passphrases: this machine has locked presence for ${mins} more minute${mins === 1 ? "" : "s"}.`;
}
