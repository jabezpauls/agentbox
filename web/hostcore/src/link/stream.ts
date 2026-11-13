import { Duplex } from "node:stream";
import { encodeFrame, FrameType, type Frame } from "./frame.js";

/**
 * Byte streams over the link: one per HTTP connection or WebSocket upgrade
 * the gate opens to a machine's HTTP server (frame.ts has the framing).
 *
 * Flow control is by credit, per stream and in each direction: a side may
 * have at most STREAM_WINDOW bytes sent that the other has not yet handed to
 * its reader, and says how much more it may take with a `window` frame (a
 * 4-byte big-endian increment) as its reader consumes. Data beyond the
 * window is a protocol error and ends the stream. So a stream never holds
 * more than its window (and its reader's own buffer) at the receiving end,
 * however slow the reader — which is what lets the gate bound its memory
 * (StreamBudget).
 *
 * `close` ends the stream both ways: whatever the closing side had sent
 * arrives first, then the end; anything written afterwards is dropped.
 */

/** Bytes a stream may have in flight towards its receiver. */
export const STREAM_WINDOW = 256 * 1024;
/** The largest data frame's payload. */
export const DATA_CHUNK = 64 * 1024;
/** Gate-wide, across every link: what all streams' windows may add up to. */
export const STREAM_BUDGET = 64 * 1024 * 1024;
/** Past the budget a new stream waits this long for room, then is refused. */
export const STREAM_QUEUE_MS = 30_000;

/** What a stream's `open` frame says (JSON): the kind of exchange, and who asks. */
export interface StreamOpen {
  kind: "http" | "upgrade";
  /** The machines session the stream is for (the gate's say; presence binds to it). */
  session: string | null;
  /** The presence grant the machine issued to that session, when there is one. */
  grant: string | null;
  /**
   * For an app on the machine-apps origin: the registered port it is for.
   * Such a stream reaches that app and nothing else of the node's; any other
   * stream never reaches an app.
   */
  app?: number;
}

export function encodeOpen(o: StreamOpen): Buffer {
  return Buffer.from(JSON.stringify(o), "utf8");
}

/** An open frame's payload; anything unreadable is a stream with no session and no grant. */
export function decodeOpen(payload: Buffer): StreamOpen {
  let v: Partial<StreamOpen> = {};
  try {
    v = JSON.parse(payload.toString("utf8")) as Partial<StreamOpen>;
  } catch {
    // An empty or broken payload: nothing claimed.
  }
  const id = (s: unknown): string | null => (typeof s === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(s) ? s : null);
  const out: StreamOpen = { kind: v.kind === "upgrade" ? "upgrade" : "http", session: id(v.session), grant: id(v.grant) };
  if (typeof v.app === "number" && Number.isInteger(v.app) && v.app >= 1 && v.app <= 65535) out.app = v.app;
  return out;
}

function windowPayload(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n, 0);
  return b;
}

export class LinkStream extends Duplex {
  /** Bytes the peer will still take from us. */
  private credit: number;
  /** Bytes the peer may still send us before it must wait for a window frame. */
  private allowance: number;
  /** Bytes received and pushed to our reader, not yet credited back. */
  private unacked = 0;
  private pending: { chunk: Buffer; cb: (err?: Error | null) => void } | null = null;
  private remoteClosed = false;
  private closeSent = false;

  constructor(
    readonly id: number,
    private readonly sendFrame: (frame: Buffer) => void,
    private readonly window = STREAM_WINDOW,
  ) {
    super({ allowHalfOpen: false });
    this.credit = window;
    this.allowance = window;
  }

  // What net.Socket has and Node's HTTP server, its client and `ws` call.
  setTimeout(_ms: number, cb?: () => void): this {
    if (cb) this.once("timeout", cb);
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }

  /** A frame for this stream, from the link. */
  receive(frame: Frame): void {
    if (this.destroyed) return;
    switch (frame.type) {
      case FrameType.data: {
        if (this.remoteClosed) return;
        const n = frame.payload.length;
        if (n === 0) return;
        this.allowance -= n;
        if (this.allowance < 0) {
          this.destroy(new Error("the far end sent past its window"));
          return;
        }
        this.unacked += n;
        if (this.push(Buffer.from(frame.payload)) && this.unacked >= this.window / 4) this.grant();
        return;
      }
      case FrameType.window: {
        if (frame.payload.length !== 4) {
          this.destroy(new Error("bad window frame"));
          return;
        }
        this.credit += frame.payload.readUInt32BE(0);
        if (this.credit > this.window * 4) {
          this.destroy(new Error("the far end widened the window past any it was given"));
          return;
        }
        this.flush();
        return;
      }
      case FrameType.close:
        this.remoteEnd();
        return;
      default:
        return;
    }
  }

  /** The far end is gone (its close, or the link's end). */
  remoteEnd(): void {
    if (this.remoteClosed) return;
    this.remoteClosed = true;
    // Nothing more goes out: there is no one to take it.
    this.closeSent = true;
    const p = this.pending;
    this.pending = null;
    p?.cb();
    this.push(null);
    // Readable or not, a stream whose far end is gone is done once its reader
    // has had what arrived.
    if (this.readableLength === 0) setImmediate(() => this.destroy());
    else this.once("end", () => this.destroy());
  }

  private grant(): void {
    if (this.unacked <= 0 || this.remoteClosed || this.closeSent) return;
    const n = this.unacked;
    this.unacked = 0;
    this.allowance += n;
    this.sendFrame(encodeFrame(FrameType.window, this.id, windowPayload(n)));
  }

  override _read(): void {
    this.grant();
  }

  private flush(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.sendChunks(p.chunk, p.cb);
  }

  private sendChunks(chunk: Buffer, cb: (err?: Error | null) => void): void {
    let off = 0;
    while (off < chunk.length) {
      if (this.remoteClosed) return cb();
      if (this.credit <= 0) {
        this.pending = { chunk: chunk.subarray(off), cb };
        return;
      }
      const n = Math.min(chunk.length - off, this.credit, DATA_CHUNK);
      this.sendFrame(encodeFrame(FrameType.data, this.id, chunk.subarray(off, off + n)));
      this.credit -= n;
      off += n;
    }
    cb();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.remoteClosed) return cb();
    this.sendChunks(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), cb);
  }

  override _final(cb: (err?: Error | null) => void): void {
    // Closing is both ways: what the far end sends from now on is not wanted.
    this.sendClose();
    cb();
    if (!this.remoteClosed) {
      this.remoteClosed = true;
      this.push(null);
      if (this.readableLength === 0) setImmediate(() => this.destroy());
      else this.once("end", () => this.destroy());
    }
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.sendClose();
    const p = this.pending;
    this.pending = null;
    p?.cb(err ?? new Error("stream closed"));
    cb(err);
  }

  private sendClose(): void {
    if (this.closeSent) return;
    this.closeSent = true;
    try {
      this.sendFrame(encodeFrame(FrameType.close, this.id));
    } catch {
      // The link is gone already.
    }
  }
}

/** The streams on one link, by id. */
export class StreamTable {
  private readonly streams = new Map<number, LinkStream>();

  constructor(
    private readonly sendFrame: (frame: Buffer) => void,
    private readonly window = STREAM_WINDOW,
  ) {}

  get size(): number {
    return this.streams.size;
  }

  has(id: number): boolean {
    return this.streams.has(id);
  }

  open(id: number): LinkStream {
    if (this.streams.has(id)) throw new Error(`stream ${id} is open already`);
    const s = new LinkStream(id, this.sendFrame, this.window);
    this.streams.set(id, s);
    s.once("close", () => {
      if (this.streams.get(id) === s) this.streams.delete(id);
    });
    // Errors end the stream; whoever holds it hears of it by its close.
    s.on("error", () => {});
    return s;
  }

  /** Route a data, window or close frame; false when no such stream is open. */
  receive(frame: Frame): boolean {
    const s = this.streams.get(frame.stream);
    if (!s) return false;
    s.receive(frame);
    return true;
  }

  /** The link ended: every stream with it. */
  endAll(reason: string): void {
    for (const s of [...this.streams.values()]) {
      s.remoteEnd();
      s.destroy(new Error(reason));
    }
    this.streams.clear();
  }
}

export class BudgetExceeded extends Error {}

/**
 * The gate's memory bound for streams: each open stream holds its window
 * (what may be in flight towards the gate on it) against a gate-wide total.
 * Past the total, a new stream waits, first come first served, up to
 * `queueMs`; then it is refused (and the gate answers 503).
 */
export class StreamBudget {
  private used = 0;
  private readonly queue: Array<{ n: number; resolve: (release: () => void) => void; timer: NodeJS.Timeout }> = [];

  constructor(
    readonly total = STREAM_BUDGET,
    private readonly queueMs = STREAM_QUEUE_MS,
  ) {}

  get inUse(): number {
    return this.used;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** Room for `n` bytes; resolves with the function that gives it back (once). */
  reserve(n: number): Promise<() => void> {
    if (n > this.total) return Promise.reject(new BudgetExceeded("larger than the whole budget"));
    if (this.queue.length === 0 && this.used + n <= this.total) return Promise.resolve(this.take(n));
    return new Promise((resolve, reject) => {
      const entry = {
        n,
        resolve,
        timer: setTimeout(() => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new BudgetExceeded("the gate is busy with other streams; try again shortly"));
        }, this.queueMs),
      };
      entry.timer.unref?.();
      this.queue.push(entry);
    });
  }

  private take(n: number): () => void {
    this.used += n;
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.used -= n;
      this.drain();
    };
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0] as (typeof this.queue)[number];
      if (this.used + head.n > this.total) return;
      this.queue.shift();
      clearTimeout(head.timer);
      head.resolve(this.take(head.n));
    }
  }
}
