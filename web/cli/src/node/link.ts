import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import {
  decodeControl,
  decodeFrame,
  decodeOpen,
  DUPLICATE_BACKOFF_MS,
  encodeControl,
  encodeFrame,
  FrameType,
  LINK_PATH,
  PROTOCOL_VERSION,
  STREAM_WINDOW,
  StreamTable,
  verifyRevoke,
  type ControlMessage,
  type Hello,
  type PolicySummary,
} from "@workbench/hostcore/link";
import { keepAlive, PING_MS } from "../keepalive.js";

/**
 * The node's end of the link: one outbound WebSocket to the gate, held for as
 * long as the node runs.
 *
 * - Reconnects with backoff from 1 s to 60 s, jittered; after an hour of
 *   failing, hourly. A wall-clock jump (the machine woke from sleep) means
 *   reconnect at once.
 * - Only the gate's signed `revoked`, over an established link, revokes. An
 *   HTTP 401, a captive portal, a proxy's page, an unsigned `revoked`: all are
 *   network failures, retried, and nothing is deleted.
 * - `duplicate` waits 5 minutes; `upgrade` waits an hour (the updater, phase
 *   6, listens for it).
 *
 * Events: `state` (LinkState), `welcome` ({ machineId, name }), `revoked`,
 * `upgrade` ({ minimum }), `log` (a line for the node's log), `control`
 * (any other message from the gate, once welcomed: the shared Claude token),
 * and `stream` (a LinkStream and its StreamOpen) for each stream the gate
 * opens — run.ts hands those to the node's HTTP server; with no listener,
 * each is refused with a close. Streams end with the link.
 */

export type LinkState = "connecting" | "online" | "offline" | "paused" | "duplicate" | "upgrade" | "revoked" | "left" | "stopped";

export interface NodeLinkOptions {
  /** The box's origin, `https://…`. */
  box: string;
  token: string;
  machineId: string;
  /** The node's version, said in the hello. */
  version: string;
  /** What the hello says besides protocol, version and nonce; gathered afresh for each link. */
  describe: () => Promise<Omit<Hello, "type" | "protocol" | "version" | "nonce">>;
  now?: () => number;
  random?: () => number;
  pingMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** After failing this long without a break, retry hourly. */
  slowAfterMs?: number;
  slowRetryMs?: number;
  duplicateBackoffMs?: number;
  wakeCheckMs?: number;
  /** A tick this much later than due means the machine slept. */
  wakeJumpMs?: number;
}

/** The wait before retry `n` (1, 2, …): doubling from `min`, at most `max`, jittered into its upper half. */
export function backoffMs(n: number, min: number, max: number, random: () => number = Math.random): number {
  const base = Math.min(max, min * 2 ** Math.max(0, n - 1));
  return Math.round(base / 2 + (base / 2) * random());
}

export class NodeLink extends EventEmitter {
  private ws: WebSocket | null = null;
  private stateNow: LinkState = "stopped";
  private running = false;
  private paused = false;
  private failures = 0;
  private failingSince: number | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private lastTick = 0;
  private nonce = "";
  private nextDelay: number | null = null;
  private readonly o: Required<Omit<NodeLinkOptions, "describe">> & Pick<NodeLinkOptions, "describe">;

  constructor(opts: NodeLinkOptions) {
    super();
    this.o = {
      now: Date.now,
      random: Math.random,
      pingMs: PING_MS,
      minBackoffMs: 1_000,
      maxBackoffMs: 60_000,
      slowAfterMs: 60 * 60_000,
      slowRetryMs: 60 * 60_000,
      duplicateBackoffMs: DUPLICATE_BACKOFF_MS,
      wakeCheckMs: 5_000,
      wakeJumpMs: 15_000,
      ...opts,
    };
  }

  get state(): LinkState {
    return this.stateNow;
  }

  private set(state: LinkState): void {
    if (state === this.stateNow) return;
    this.stateNow = state;
    this.emit("state", state);
  }

  private log(line: string): void {
    this.emit("log", line);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTick = this.o.now();
    this.wakeTimer = setInterval(() => this.tick(), this.o.wakeCheckMs);
    this.wakeTimer.unref();
    if (!this.paused) this.connect();
    else this.set("paused");
  }

  stop(state: LinkState = "stopped"): void {
    this.running = false;
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.wakeTimer = null;
    this.clearRetry();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "stopping");
    this.set(state);
  }

  /** `agentbox node pause`: say so, close, and stay closed until resume. */
  pause(): void {
    this.paused = true;
    this.clearRetry();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encodeControl({ type: "pause" }));
      ws.close(1000, "paused");
    } else {
      ws?.terminate();
    }
    if (this.running) this.set("paused");
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.failures = 0;
    this.failingSince = null;
    if (this.running && !this.ws) this.connect();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  sendPolicy(policy: PolicySummary): void {
    if (this.stateNow === "online" && this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeControl({ type: "policy", policy }));
  }

  /** Tell the box this machine is leaving; resolves whether it was told. */
  leave(timeoutMs = 5_000): Promise<boolean> {
    const ws = this.ws;
    if (!ws || this.stateNow !== "online" || ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      ws.once("close", (code) => {
        clearTimeout(timer);
        resolve(code === 4005);
      });
      ws.send(encodeControl({ type: "leave" }));
    });
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** The wall clock jumped: the machine slept. Whatever was waiting, go now. */
  private tick(): void {
    const t = this.o.now();
    const late = t - this.lastTick - this.o.wakeCheckMs;
    this.lastTick = t;
    if (late < this.o.wakeJumpMs || !this.running || this.paused) return;
    if (this.stateNow === "revoked" || this.stateNow === "left") return;
    this.log(`woke after ${Math.round(late / 1000)} s; reconnecting now`);
    this.failures = 0;
    if (this.ws) {
      // Probably dead after a sleep; its close schedules no retry of its own.
      const ws = this.ws;
      this.ws = null;
      ws.terminate();
    }
    this.clearRetry();
    this.connect();
  }

  private retry(): void {
    if (!this.running || this.paused) return;
    const t = this.o.now();
    let delay: number;
    if (this.nextDelay !== null) {
      delay = this.nextDelay;
      this.nextDelay = null;
    } else {
      this.failures += 1;
      this.failingSince ??= t;
      delay =
        t - this.failingSince >= this.o.slowAfterMs
          ? this.o.slowRetryMs
          : backoffMs(this.failures, this.o.minBackoffMs, this.o.maxBackoffMs, this.o.random);
    }
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref();
  }

  private connect(): void {
    if (!this.running || this.paused || this.ws) return;
    this.set("connecting");
    const url = `${this.o.box.replace(/^http/, "ws")}${LINK_PATH}`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.o.token}` }, perMessageDeflate: false, handshakeTimeout: 20_000, followRedirects: false });
    this.ws = ws;
    let welcomed = false;
    let stopKeepAlive = (): void => {};
    const streams = new StreamTable((f) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(f);
    }, STREAM_WINDOW);

    ws.on("unexpected-response", (_req, res) => {
      // A 401, a captive portal, a proxy's page: a network failure.
      this.log(`the box answered the link with HTTP ${res.statusCode}; retrying`);
      res.resume();
      ws.terminate();
    });
    ws.on("error", (err) => this.log(`link error: ${err.message}`));
    ws.on("open", () => {
      stopKeepAlive = keepAlive(
        ws,
        () => {
          this.log("the box stopped answering pings; reconnecting");
          ws.terminate();
        },
        this.o.pingMs,
      );
      this.nonce = randomBytes(32).toString("base64url");
      void this.o.describe().then(
        (d) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const hello: Hello = { type: "hello", protocol: PROTOCOL_VERSION, version: this.o.version, nonce: this.nonce, ...d };
          ws.send(encodeControl(hello as unknown as ControlMessage));
        },
        (err: unknown) => {
          this.log(`could not describe this machine: ${(err as Error).message}`);
          ws.terminate();
        },
      );
    });
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      let frame;
      try {
        frame = decodeFrame(data);
      } catch {
        this.log("the box sent a malformed frame; reconnecting");
        ws.terminate();
        return;
      }
      if (frame.type === FrameType.control) {
        let m: ControlMessage;
        try {
          m = decodeControl(frame.payload);
        } catch {
          return;
        }
        if (m.type === "ok") {
          welcomed = true;
          this.failures = 0;
          this.failingSince = null;
          this.set("online");
          this.emit("welcome", { machineId: m.machineId, name: m.name });
        } else if (m.type === "revoked") {
          if (verifyRevoke(this.o.token, this.o.machineId, this.nonce, m.mac)) {
            this.log("the box revoked this machine");
            this.emit("revoked");
            this.stop("revoked");
          } else {
            // Not this box's gate, or not this link: nothing is revoked.
            this.log("ignored a revoked message that was not signed for this machine and link");
            ws.terminate();
          }
        } else if (m.type === "duplicate") {
          this.log("the box refused this link: this machine is already linked from elsewhere; waiting 5 minutes");
          this.set("duplicate");
          this.nextDelay = this.o.duplicateBackoffMs;
        } else if (m.type === "upgrade") {
          this.log(`the box needs a newer node (protocol ${String(m.minimum)}); waiting an hour`);
          this.set("upgrade");
          this.nextDelay = this.o.slowRetryMs;
          this.emit("upgrade", { minimum: m.minimum });
        } else if (welcomed) {
          this.emit("control", m);
        }
        return;
      }
      if (frame.type === FrameType.open) {
        if (!welcomed || this.listenerCount("stream") === 0 || streams.has(frame.stream)) {
          ws.send(encodeFrame(FrameType.close, frame.stream));
          return;
        }
        this.emit("stream", streams.open(frame.stream), decodeOpen(frame.payload));
        return;
      }
      if (!streams.receive(frame) && frame.type !== FrameType.close) ws.send(encodeFrame(FrameType.close, frame.stream));
    });
    ws.on("close", (code) => {
      stopKeepAlive();
      streams.endAll("the link closed");
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.running || this.stateNow === "revoked") return;
      if (code === 4005) {
        this.stop("left");
        return;
      }
      if (welcomed) {
        // It was up: start over from the shortest wait.
        this.failures = 0;
        this.failingSince = null;
      }
      if (this.stateNow !== "duplicate" && this.stateNow !== "upgrade") this.set("offline");
      this.retry();
    });
  }
}
