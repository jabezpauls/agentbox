import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  CONTROL_PER_SECOND,
  decodeControl,
  BudgetExceeded,
  decodeFrame,
  DUPLICATE_BACKOFF_MS,
  encodeControl,
  encodeFrame,
  encodeOpen,
  FrameError,
  FrameType,
  HELLO_MAX_BYTES,
  HELLO_TIMEOUT_MS,
  MAX_STREAMS_PER_LINK,
  MIN_PROTOCOL_VERSION,
  MISSED_PINGS,
  NODE_TOKEN_SHAPE,
  parseHello,
  parsePolicySummary,
  PING_MS,
  revokeMac,
  STALE_PONG_MS,
  STREAM_WINDOW,
  StreamBudget,
  StreamTable,
  type ControlMessage,
  type GateAnswer,
  type Hello,
} from "../link/index.js";
import { bearerToken } from "../auth.js";
import type { RequestInfo } from "../context.js";
import { refuseUpgrade } from "../proxy.js";
import type { MachinesAudit } from "./audit.js";
import type { Registry } from "./registry.js";

/**
 * The link: each machine's node holds one outbound WebSocket to
 * `wss://<box>/_gate/node`, on the box's own hostname, through the proxy
 * only, with its node token and nothing else. A node token is accepted here
 * and nowhere else; nothing else is accepted here.
 *
 * On a link the node says hello (at most 16 KiB, within 10 s); the gate
 * answers `ok`, `upgrade`, `duplicate` or a signed `revoked` (protocol.ts).
 * Pings every 25 s each way; two missed and the machine is offline. One link
 * per machine: a second, while the first still answers a ping within 5 s, is
 * refused as a duplicate; a first that does not answer is replaced.
 *
 * Streams: the gate opens one per HTTP connection or WebSocket upgrade bound
 * for the machine's HTTP server (`openStream`, stream.ts); a node may never
 * open one. Each holds its window against the gate-wide budget, and past it
 * waits up to 30 s for room before it is refused with a 503.
 */

export type StreamKind = "http" | "upgrade";

export class StreamRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface LinkOptions {
  registry: Registry;
  audit: MachinesAudit;
  /** Whether links are served at all (machines on, with a passphrase). */
  enabled: () => boolean;
  now?: () => number;
  pingMs?: number;
  missedPings?: number;
  stalePongMs?: number;
  helloTimeoutMs?: number;
  minProtocol?: number;
  /** The gate-wide stream budget (tests make it small). */
  budget?: StreamBudget;
  /** A machine's link is up (said ok): what it should be told now (the shared Claude token). */
  onOnline?: (machineId: string) => void;
}

/** Who a stream is for: the machines session and its presence grant, which the node checks. */
export interface StreamFor {
  session: string | null;
  grant: string | null;
}

interface Live {
  machineId: string;
  ws: WebSocket;
  hello: Hello;
  ip: string;
  /** Streams open on this link. */
  streams: StreamTable;
  nextStream: number;
  stop: () => void;
}

/** Close codes the node reads (beside 1000/1001). */
export const CLOSE = { protocol: 1002, policy: 1008, revoked: 4001, duplicate: 4002, upgrade: 4003, off: 4004, left: 4005, replaced: 4006 } as const;

export class LinkHub {
  private readonly wss: WebSocketServer;
  private readonly live = new Map<string, Live>();
  private readonly pending = new Set<WebSocket>();
  private readonly now: () => number;
  private readonly pingMs: number;
  private readonly missed: number;
  private readonly staleMs: number;
  private readonly helloMs: number;
  private readonly minProtocol: number;
  private readonly budget: StreamBudget;

  constructor(private readonly opts: LinkOptions) {
    this.now = opts.now ?? Date.now;
    this.pingMs = opts.pingMs ?? PING_MS;
    this.missed = opts.missedPings ?? MISSED_PINGS;
    this.staleMs = opts.stalePongMs ?? STALE_PONG_MS;
    this.helloMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this.minProtocol = opts.minProtocol ?? MIN_PROTOCOL_VERSION;
    this.budget = opts.budget ?? new StreamBudget();
    // Room for a stream's window and its header; control is bounded tighter by the codec.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 + 16, perMessageDeflate: false });
  }

  isOnline(machineId: string): boolean {
    return this.live.has(machineId);
  }

  onlineCount(): number {
    return this.live.size;
  }

  /** A WebSocket handshake for `/_gate/node`. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, info: RequestInfo): void {
    const { registry } = this.opts;
    if (!this.opts.enabled()) return refuseUpgrade(socket, 404, "Not Found");
    // From the proxy only: the sandbox reaching the gate's listener directly gets nothing here.
    if (!info.viaProxy) return refuseUpgrade(socket, 421, "Misdirected Request");
    const token = bearerToken(req.headers.authorization);
    if (token === null || !NODE_TOKEN_SHAPE.test(token)) return refuseUpgrade(socket, 401, "Unauthorized");
    const rec = registry.byToken(token);
    // Unknown, or left: a plain 401, which the node takes for a network failure.
    if (!rec || rec.state === "left") return refuseUpgrade(socket, 401, "Unauthorized");
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accepted(ws, rec.id, info.ip));
  }

  private accepted(ws: WebSocket, machineId: string, ip: string): void {
    this.pending.add(ws);
    ws.on("error", () => ws.terminate());
    const helloTimer = setTimeout(() => ws.close(CLOSE.protocol, "no hello"), this.helloMs);
    helloTimer.unref();
    ws.once("close", () => {
      clearTimeout(helloTimer);
      this.pending.delete(ws);
    });
    ws.once("message", (data: RawData, isBinary: boolean) => {
      clearTimeout(helloTimer);
      void this.onHello(ws, machineId, ip, data, isBinary).catch((err: unknown) => {
        console.error("[gate] link hello failed", err);
        ws.terminate();
      });
    });
  }

  private send(ws: WebSocket, message: GateAnswer | ControlMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeControl(message as ControlMessage));
  }

  private async onHello(ws: WebSocket, machineId: string, ip: string, data: RawData, isBinary: boolean): Promise<void> {
    const { registry, audit } = this.opts;
    const buf = toBuffer(data);
    if (!isBinary || buf.length > HELLO_MAX_BYTES + 5) return ws.close(CLOSE.protocol, "bad hello");
    let hello: Hello | string;
    try {
      const frame = decodeFrame(buf);
      if (frame.type !== FrameType.control) return ws.close(CLOSE.protocol, "bad hello");
      hello = parseHello(decodeControl(frame.payload));
    } catch {
      return ws.close(CLOSE.protocol, "bad hello");
    }
    if (typeof hello === "string") return ws.close(CLOSE.protocol, hello.slice(0, 100));
    const rec = registry.get(machineId);
    if (!rec || rec.state === "left" || !this.opts.enabled()) return ws.close(CLOSE.off, "machines are off");

    if (rec.state === "revoked") {
      // Signed with the token's digest and bound to this link's nonce: only
      // this box's gate can say it, and only to this link.
      this.send(ws, { type: "revoked", machineId: rec.id, mac: revokeMac(rec.tokenHash, rec.id, hello.nonce) });
      audit.record("revoked", { machineId: rec.id, name: rec.name, ip, detail: "told on its link" });
      return ws.close(CLOSE.revoked, "revoked");
    }
    if (hello.protocol < this.minProtocol) {
      registry.upgradeNeeded(rec.id);
      audit.record("upgrade", { machineId: rec.id, name: rec.name, ip, detail: `protocol ${hello.protocol}, node ${hello.version}` });
      this.send(ws, { type: "upgrade", minimum: this.minProtocol, message: "this node is too old for the box; update it" });
      return ws.close(CLOSE.upgrade, "upgrade");
    }

    const first = this.live.get(rec.id);
    if (first) {
      if (await answersPing(first.ws, this.staleMs)) {
        registry.duplicate(rec.id);
        audit.record("duplicate", { machineId: rec.id, name: rec.name, ip, detail: `refused; the link from ${first.ip} still answers` });
        console.warn(`[gate] a second link for machine ${rec.name} from ${ip} refused: the first still answers`);
        this.send(ws, { type: "duplicate", retryAfterMs: DUPLICATE_BACKOFF_MS, message: "this machine is already linked from elsewhere" });
        return ws.close(CLOSE.duplicate, "duplicate");
      }
      this.drop(first, CLOSE.replaced, "replaced by a new link");
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    this.pending.delete(ws);
    this.start(ws, rec.id, ip, hello);
  }

  private start(ws: WebSocket, machineId: string, ip: string, hello: Hello): void {
    const { registry, audit } = this.opts;
    const rec = registry.get(machineId);
    if (!rec) return ws.close(CLOSE.off, "unknown");
    registry.hello(rec, hello, ip);

    let unanswered = 0;
    const alive = (): void => {
      unanswered = 0;
    };
    ws.on("pong", alive);
    const heartbeat = setInterval(() => {
      if (unanswered >= this.missed) {
        console.warn(`[gate] machine ${rec.name} missed ${unanswered} pings; offline`);
        ws.terminate();
        return;
      }
      unanswered += 1;
      ws.ping();
    }, this.pingMs);
    heartbeat.unref();

    // Control messages: at most CONTROL_PER_SECOND in any second.
    const recent: number[] = [];
    const live: Live = {
      machineId,
      ws,
      hello,
      ip,
      streams: new StreamTable((frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      }, STREAM_WINDOW),
      nextStream: 1,
      stop: () => {
        clearInterval(heartbeat);
        ws.off("pong", alive);
      },
    };
    this.live.set(machineId, live);
    this.send(ws, { type: "ok", machineId: rec.id, name: rec.name });
    this.opts.onOnline?.(machineId);
    audit.record("online", { machineId: rec.id, name: rec.name, ip, detail: `node ${hello.version} on ${hello.platform}/${hello.arch}` });
    console.log(`[gate] machine ${rec.name} online from ${ip}`);

    ws.on("message", (data: RawData, isBinary: boolean) => {
      alive();
      if (!isBinary) return ws.close(CLOSE.protocol, "binary frames only");
      let frame;
      try {
        frame = decodeFrame(toBuffer(data));
      } catch (err) {
        return ws.close(CLOSE.protocol, err instanceof FrameError ? err.message.slice(0, 100) : "bad frame");
      }
      if (frame.type !== FrameType.control) {
        // The gate opens streams; a node never does. Anything for a stream the
        // gate has not opened is answered with its close.
        if (frame.type === FrameType.open || !live.streams.receive(frame)) {
          if (frame.type !== FrameType.close) ws.send(encodeFrame(FrameType.close, frame.stream));
        }
        return;
      }
      const t = this.now();
      while (recent.length && (recent[0] as number) <= t - 1000) recent.shift();
      recent.push(t);
      if (recent.length > CONTROL_PER_SECOND) return ws.close(CLOSE.policy, "too many control messages");
      let m: ControlMessage;
      try {
        m = decodeControl(frame.payload);
      } catch {
        return ws.close(CLOSE.protocol, "bad control message");
      }
      this.onControl(live, m);
    });

    ws.once("close", () => {
      live.stop();
      live.streams.endAll("machine offline");
      if (this.live.get(machineId) !== live) return;
      this.live.delete(machineId);
      const now = registry.get(machineId);
      if (!now) return;
      registry.seen(now);
      if (now.state === "active") {
        audit.record(now.pausedAt !== null ? "paused" : "offline", { machineId, name: now.name, ip });
        console.log(`[gate] machine ${now.name} ${now.pausedAt !== null ? "paused" : "offline"}`);
      }
    });
  }

  private onControl(live: Live, m: ControlMessage): void {
    const { registry, audit } = this.opts;
    const rec = registry.get(live.machineId);
    if (!rec) return;
    switch (m.type) {
      case "policy": {
        const policy = parsePolicySummary(m.policy);
        if (policy) registry.policy(rec, policy);
        return;
      }
      case "pause":
        registry.paused(rec);
        return;
      case "leave":
        void registry.left(rec.id).then(() => {
          audit.record("left", { machineId: rec.id, name: rec.name, ip: live.ip });
          live.ws.close(CLOSE.left, "left");
        });
        return;
      default:
        // Nothing else a node says does anything.
        return;
    }
  }

  private drop(live: Live, code: number, reason: string): void {
    live.ws.close(code, reason);
    // Not waiting for the far end: gone from here now.
    setTimeout(() => live.ws.terminate(), 2_000).unref();
  }

  /** The owner revoked it: told, signed, now, if it is online; its next link otherwise. */
  revoke(machineId: string): void {
    const live = this.live.get(machineId);
    const rec = this.opts.registry.get(machineId);
    if (!live || !rec) return;
    this.send(live.ws, { type: "revoked", machineId, mac: revokeMac(rec.tokenHash, machineId, live.hello.nonce) });
    this.drop(live, CLOSE.revoked, "revoked");
  }

  /** Removed from the registry: its link ends (and its token opens nothing again). */
  disconnect(machineId: string, reason = "removed"): void {
    const live = this.live.get(machineId);
    if (live) this.drop(live, CLOSE.off, reason);
  }

  /** Machines turned off: every link ends, and none is taken until they are on again. */
  closeAll(reason = "machines are off"): number {
    const n = this.live.size;
    for (const live of [...this.live.values()]) this.drop(live, CLOSE.off, reason);
    for (const ws of this.pending) ws.terminate();
    return n;
  }

  /** Say `message` to a machine on its link; false when it is not online. */
  sendControl(machineId: string, message: ControlMessage): boolean {
    const live = this.live.get(machineId);
    if (!live || live.ws.readyState !== WebSocket.OPEN) return false;
    this.send(live.ws, message);
    return true;
  }

  /**
   * A byte stream to `machineId`'s HTTP server, over its link, for `who`:
   * the node is told the machines session and its presence grant in the
   * stream's open frame, and decides by them (and its policy) what to serve.
   * Refused (503) when the machine is offline or has its 256 streams, or when
   * the gate-wide budget has no room within 30 s.
   */
  async openStream(machineId: string, kind: StreamKind, who: StreamFor = { session: null, grant: null }): Promise<Duplex> {
    const full = () => new StreamRefused(`this machine has ${MAX_STREAMS_PER_LINK} streams open already`, 503);
    const first = this.live.get(machineId);
    if (!first) throw new StreamRefused("machine offline", 503);
    if (first.streams.size >= MAX_STREAMS_PER_LINK) throw full();
    let release: () => void;
    try {
      release = await this.budget.reserve(STREAM_WINDOW);
    } catch (err) {
      if (err instanceof BudgetExceeded) throw new StreamRefused(err.message, 503);
      throw err;
    }
    const live = this.live.get(machineId);
    if (!live || live.ws.readyState !== WebSocket.OPEN) {
      release();
      throw new StreamRefused("machine offline", 503);
    }
    if (live.streams.size >= MAX_STREAMS_PER_LINK) {
      release();
      throw full();
    }
    let id = live.nextStream;
    while (live.streams.has(id)) id = id >= 0xffff_ffff ? 1 : id + 1;
    live.nextStream = id >= 0xffff_ffff ? 1 : id + 1;
    const stream = live.streams.open(id);
    stream.once("close", release);
    live.ws.send(encodeFrame(FrameType.open, id, encodeOpen({ kind, session: who.session, grant: who.grant })));
    return stream;
  }

  /** What the stream budget holds now (for tests and the log). */
  budgetInUse(): number {
    return this.budget.inUse;
  }

  close(): void {
    this.closeAll("the gate is stopping");
    this.wss.close();
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

/** Whether `ws` answers a ping within `ms`. */
function answersPing(ws: WebSocket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (ws.readyState !== WebSocket.OPEN) return resolve(false);
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      ws.off("pong", onPong);
      ws.off("close", onClose);
      resolve(ok);
    };
    const onPong = (): void => done(true);
    const onClose = (): void => done(false);
    const timer = setTimeout(() => done(false), ms);
    ws.on("pong", onPong);
    ws.on("close", onClose);
    ws.ping();
  });
}
