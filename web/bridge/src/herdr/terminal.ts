import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { TerminalServerMessage } from "@workbench/shared";

/**
 * A single browser connection watching one pane. Frames arrive as raw ANSI
 * bytes (binary ws messages); control notices such as size or close arrive as
 * JSON text.
 */
export interface Viewer {
  send(data: Buffer): void;
  sendJson(m: TerminalServerMessage): void;
  close(reason: string): void;
}

/**
 * The handle the ws route drives while a viewer is attached. Every method maps
 * to a herdr terminal command; `detach` removes this viewer and releases the
 * controller once it was the last one.
 */
export interface Attachment {
  input(text?: string, bytes?: string): void;
  resize(cols: number, rows: number): void;
  scroll(direction: "up" | "down", lines: number): void;
  focus(): void;
  detach(): void;
}

interface HerdrFrame {
  type: "terminal.frame";
  seq: number;
  encoding: string;
  width: number;
  height: number;
  full: boolean;
  bytes: string;
}
interface HerdrClosed {
  type: "terminal.closed";
  reason?: string;
}

/** Cap on buffered diffs before a late joiner is forced a fresh repaint. */
const MAX_REPLAY_BYTES = 1_000_000;
/** Grace period for the child to exit cleanly after release before SIGTERM. */
const RELEASE_GRACE_MS = 1_000;

/**
 * One `herdr terminal session control --takeover` child per pane. herdr renders
 * the viewport server side; this class decodes each frame once and fans the raw
 * bytes out to every viewer, so browsers keep no scrollback and share a single
 * controller. The most recent focus/resize wins the pane size.
 */
class PaneStream {
  private child: ChildProcess;
  private readonly viewers = new Set<Viewer>();
  /** Last full frame; the baseline replayed to late joiners. */
  private full: Buffer | null = null;
  /** Diffs received since the last full frame, replayed after it. */
  private diffs: Buffer[] = [];
  private diffBytes = 0;
  private cols: number;
  private rows: number;
  /** Last size each viewer asked for, so focus can restore that viewer's size. */
  private readonly viewerSize = new WeakMap<Viewer, { cols: number; rows: number }>();
  lastFullSeq = 0;
  private released = false;
  private dead = false;

  constructor(
    private readonly paneId: string,
    private readonly env: NodeJS.ProcessEnv,
    cols: number,
    rows: number,
    /** Called once when the child dies, so the registry can drop this stream. */
    private readonly onDead: (paneId: string, stream: PaneStream) => void,
  ) {
    this.cols = cols;
    this.rows = rows;
    this.child = this.spawn();
  }

  /** True once the child has exited/errored or herdr reported the pane closed. */
  get isDead(): boolean {
    return this.dead;
  }

  private spawn(): ChildProcess {
    const child = spawn(
      "herdr",
      [
        "terminal",
        "session",
        "control",
        this.paneId,
        "--takeover",
        "--cols",
        String(this.cols),
        "--rows",
        String(this.rows),
      ],
      { env: this.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    if (child.stdout) {
      readline.createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    }
    // Drain stderr so a chatty child never blocks on a full pipe.
    child.stderr?.resume();
    child.on("error", () => this.markDead("stream error"));
    child.on("exit", () => this.markDead("stream ended"));
    return child;
  }

  /**
   * Mark the stream dead exactly once (dropping it from the registry) and close
   * any remaining viewers. Called on child exit/error and on terminal.closed.
   */
  private markDead(reason: string): void {
    if (!this.dead) {
      this.dead = true;
      this.onDead(this.paneId, this);
    }
    this.shutdownViewers(reason);
  }

  private shutdownViewers(reason: string): void {
    for (const v of this.viewers) v.close(reason);
    this.viewers.clear();
  }

  private onLine(line: string): void {
    let msg: HerdrFrame | HerdrClosed;
    try {
      msg = JSON.parse(line) as HerdrFrame | HerdrClosed;
    } catch {
      return;
    }
    if (msg.type === "terminal.frame") {
      const buf = Buffer.from(msg.bytes, "base64");
      if (msg.full) {
        this.full = buf;
        this.diffs = [];
        this.diffBytes = 0;
        this.lastFullSeq = msg.seq;
      } else {
        this.diffs.push(buf);
        this.diffBytes += buf.length;
        if (this.diffBytes > MAX_REPLAY_BYTES) {
          // Replay buffer too large: drop it and the baseline so it cannot grow
          // unbounded. Late joiners then get a forced repaint instead of replay.
          this.full = null;
          this.diffs = [];
          this.diffBytes = 0;
        }
      }
      for (const v of this.viewers) v.send(buf);
    } else if (msg.type === "terminal.closed") {
      this.markDead(msg.reason ?? "closed");
    }
  }

  private write(o: object): void {
    this.child.stdin?.write(JSON.stringify(o) + "\n");
  }

  addViewer(v: Viewer, cols: number, rows: number): void {
    this.viewers.add(v);
    this.viewerSize.set(v, { cols, rows });
    // A late joiner whose size matches the current one, with a small replay
    // buffer, gets the last full frame plus diffs. Otherwise force a repaint by
    // resizing to its size (any resize, even to the same size, repaints).
    if (this.full && this.diffBytes < MAX_REPLAY_BYTES && cols === this.cols && rows === this.rows) {
      v.send(this.full);
      for (const d of this.diffs) v.send(d);
    } else {
      this.resize(cols, rows);
    }
  }

  removeViewer(v: Viewer): void {
    if (!this.viewers.delete(v)) return;
    if (this.viewers.size === 0) this.release();
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.write({ type: "terminal.release" });
    this.child.stdin?.end();
    setTimeout(() => {
      if (!this.child.killed) this.child.kill("SIGTERM");
    }, RELEASE_GRACE_MS).unref();
  }

  /** Kill the child immediately; used on shutdown, not on normal release. */
  destroy(): void {
    this.released = true;
    this.child.stdin?.end();
    if (!this.child.killed) this.child.kill("SIGTERM");
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.write({ type: "terminal.resize", cols, rows });
    for (const v of this.viewers) v.sendJson({ type: "size", cols, rows });
  }

  /** Record this viewer's size and make it the current pane size. */
  resizeFor(v: Viewer, cols: number, rows: number): void {
    this.viewerSize.set(v, { cols, rows });
    this.resize(cols, rows);
  }

  /** The focusing viewer becomes the size owner: restore its last known size. */
  focus(v: Viewer): void {
    const size = this.viewerSize.get(v) ?? { cols: this.cols, rows: this.rows };
    this.resize(size.cols, size.rows);
  }

  input(text?: string, bytes?: string): void {
    this.write({ type: "terminal.input", ...(bytes ? { bytes } : { text: text ?? "" }) });
  }

  scroll(direction: "up" | "down", lines: number): void {
    this.write({ type: "terminal.scroll", direction, lines: Math.max(1, lines | 0), source: "wheel" });
  }

  size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  get viewerCount(): number {
    return this.viewers.size;
  }
}

/**
 * Registry of live pane streams. The first viewer of a pane spawns its
 * controller; the last one leaving tears it down.
 */
export class TerminalStreams {
  private readonly streams = new Map<string, PaneStream>();

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  /** Drop a stream from the registry, but only if it is still the live one. */
  private forget(paneId: string, stream: PaneStream): void {
    if (this.streams.get(paneId) === stream) this.streams.delete(paneId);
  }

  attach(paneId: string, viewer: Viewer, cols = 80, rows = 24): Attachment {
    let stream = this.streams.get(paneId);
    // A dead stream (child gone, closed cascade not yet finished) must never be
    // reused: spawn a fresh controller in its place.
    if (!stream || stream.isDead) {
      stream = new PaneStream(paneId, this.env, cols, rows, (p, s) => this.forget(p, s));
      this.streams.set(paneId, stream);
    }
    stream.addViewer(viewer, cols, rows);
    const s = stream;
    let detached = false;
    return {
      input: (text, bytes) => s.input(text, bytes),
      resize: (c, r) => s.resizeFor(viewer, c, r),
      scroll: (direction, lines) => s.scroll(direction, lines),
      focus: () => s.focus(viewer),
      detach: () => {
        // Idempotent per attachment: a double detach from the same viewer must
        // not touch a stream that a later viewer now owns.
        if (detached) return;
        detached = true;
        s.removeViewer(viewer);
        if (s.viewerCount === 0) this.forget(paneId, s);
      },
    };
  }

  active(paneId: string): boolean {
    return this.streams.has(paneId);
  }

  size(paneId: string): { cols: number; rows: number } | null {
    return this.streams.get(paneId)?.size() ?? null;
  }

  lastFullSeq(paneId: string): number {
    return this.streams.get(paneId)?.lastFullSeq ?? 0;
  }

  /** Test-only: number of live pane streams in the registry. */
  streamCount(): number {
    return this.streams.size;
  }

  /** Tear down every live stream; call on server shutdown. */
  stop(): void {
    for (const s of this.streams.values()) s.destroy();
    this.streams.clear();
  }
}
