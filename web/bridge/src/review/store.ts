import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type {
  ReviewComment,
  ReviewEndedBy,
  ReviewSession,
  ReviewSessionDetail,
} from "@workbench/shared";

/** A session key is a short hash, so it is also a safe single path segment. */
export const KEY_PATTERN = /^[0-9a-f]{8}$/;

/** The key for an artifact path: stable, so re-opening a file resumes it. */
export function keyForFile(file: string): string {
  return createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 8);
}

export interface PollResult {
  key: string;
  status: ReviewSession["status"];
  comments: ReviewComment[];
  /** True when the wait elapsed with nothing queued; the CLI exits 3 on it. */
  timedOut: boolean;
}

export class NotFoundError extends Error {}

/** A comment as it arrives from the browser, before the store timestamps it. */
export interface IncomingComment {
  kind?: unknown;
  anchor?: unknown;
  quote?: unknown;
  note?: unknown;
}

const KINDS = new Set(["element", "selection", "note"]);
const MAX_QUOTE = 400;
const MAX_NOTE = 4000;

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/** Normalise one comment from the browser; anything unrecognised becomes a note. */
export function sanitiseComment(raw: IncomingComment): ReviewComment | null {
  const note = str(raw.note, MAX_NOTE);
  if (!note) return null;
  const kind = typeof raw.kind === "string" && KINDS.has(raw.kind) ? (raw.kind as ReviewComment["kind"]) : "note";
  const out: ReviewComment = { kind, note, at: new Date().toISOString() };
  if (kind !== "note") {
    const anchor = str(raw.anchor, MAX_QUOTE);
    const quote = str(raw.quote, MAX_QUOTE);
    if (anchor) out.anchor = anchor;
    if (quote) out.quote = quote;
  }
  return out;
}

interface StoredSession {
  key: string;
  label: string;
  file: string;
  created: string;
  updated: string;
  status: ReviewSession["status"];
  endedBy?: ReviewEndedBy;
}

/**
 * The review sessions on disk: one directory per session holding the agent's
 * artifact as it was published, the session metadata, and the queue of
 * comments the human has sent but the agent has not yet collected.
 *
 * The queue is the interesting part. An agent blocks in `agentbox-review poll`,
 * which long-polls `take()`; a browser `post()` must wake exactly one waiter,
 * and the comments it hands over must be removed from disk in the same step so
 * a second poller cannot collect them again. Every read-modify-write of a
 * session's queue therefore runs inside a per-key serial lock.
 */
export class ReviewStore {
  private readonly root: string;
  /** Per-key tail of the serialised read-modify-write chain. */
  private locks = new Map<string, Promise<unknown>>();
  /** Per-key waiters, woken when feedback is posted or the session ends. */
  private waiters = new Map<string, Set<() => void>>();

  constructor(root: string) {
    this.root = root;
  }

  private dir(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new NotFoundError(`bad key: ${key}`);
    return path.join(this.root, key);
  }

  /** Serialise work on one session so two pollers never see the same queue. */
  private lock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(work, work);
    // Keep the chain alive but never let a rejection poison the next link.
    this.locks.set(key, next.then(
      () => {},
      () => {},
    ));
    return next;
  }

  private wake(key: string): void {
    const set = this.waiters.get(key);
    if (!set) return;
    for (const w of [...set]) w();
  }

  private async readSession(key: string): Promise<StoredSession> {
    const file = path.join(this.dir(key), "session.json");
    let raw: string;
    try {
      raw = await fsp.readFile(file, "utf8");
    } catch {
      throw new NotFoundError(`no session ${key}`);
    }
    return parseSession(key, raw);
  }

  private async writeSession(s: StoredSession): Promise<void> {
    await writeAtomic(path.join(this.dir(s.key), "session.json"), JSON.stringify(s, null, 2));
  }

  private async readQueue(key: string): Promise<ReviewComment[]> {
    try {
      const raw = await fsp.readFile(path.join(this.dir(key), "feedback.json"), "utf8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ReviewComment[]) : [];
    } catch {
      // Missing or corrupt: an empty queue is the only safe reading, and the
      // next post overwrites the file anyway.
      return [];
    }
  }

  private async writeQueue(key: string, comments: ReviewComment[]): Promise<void> {
    await writeAtomic(path.join(this.dir(key), "feedback.json"), JSON.stringify(comments, null, 2));
  }

  /**
   * Create a session for `file`, or resume the existing one for that path and
   * refresh its stored artifact. Ending and re-opening the same file reopens it.
   */
  async open(file: string, label?: string): Promise<{ key: string; resumed: boolean; session: ReviewSession }> {
    const abs = path.resolve(file);
    const html = await fsp.readFile(abs, "utf8");
    const key = keyForFile(abs);
    const dir = path.join(this.root, key);
    await fsp.mkdir(dir, { recursive: true });

    return this.lock(key, async () => {
      let existing: StoredSession | null = null;
      try {
        existing = await this.readSession(key);
      } catch {
        existing = null;
      }
      const now = new Date().toISOString();
      const session: StoredSession = {
        key,
        label: label?.trim() || existing?.label || path.basename(abs),
        file: abs,
        created: existing?.created ?? now,
        updated: now,
        status: "open",
      };
      await writeAtomic(path.join(dir, "artifact.html"), html);
      await this.writeSession(session);
      // Re-opening an ended session is a fresh round of review; anything the
      // agent never collected would be stale, so the queue starts empty.
      if (existing?.status === "ended") await this.writeQueue(key, []);
      const pending = (await this.readQueue(key)).length;
      // A resumed session may have a poller parked on it; the artifact it is
      // reviewing has just changed, so let it re-check rather than block on a
      // page that no longer exists.
      this.wake(key);
      return { key, resumed: existing !== null, session: { ...session, pending } };
    });
  }

  /** Every session, newest first. A corrupt session.json is skipped, not fatal. */
  async list(): Promise<ReviewSession[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.root);
    } catch {
      return [];
    }
    const out: ReviewSession[] = [];
    for (const name of names) {
      if (!KEY_PATTERN.test(name)) continue;
      try {
        const s = await this.readSession(name);
        out.push({ ...s, pending: (await this.readQueue(name)).length });
      } catch {
        // A half-written or hand-edited session must not take the list down.
      }
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /** One session with the comments queued for the agent. */
  async get(key: string): Promise<ReviewSessionDetail> {
    const s = await this.readSession(key);
    const comments = await this.readQueue(key);
    return { session: { ...s, pending: comments.length }, comments };
  }

  /** The stored artifact, exactly as it was when the agent published it. */
  async artifact(key: string): Promise<string> {
    try {
      return await fsp.readFile(path.join(this.dir(key), "artifact.html"), "utf8");
    } catch {
      throw new NotFoundError(`no artifact for ${key}`);
    }
  }

  /** Queue the human's comments, optionally ending the session. */
  async post(key: string, incoming: IncomingComment[], end = false): Promise<ReviewSessionDetail> {
    return this.lock(key, async () => {
      const session = await this.readSession(key);
      const queue = await this.readQueue(key);
      for (const raw of incoming) {
        const c = sanitiseComment(raw);
        if (c) queue.push(c);
      }
      await this.writeQueue(key, queue);
      session.updated = new Date().toISOString();
      if (end) {
        session.status = "ended";
        session.endedBy = "human";
      }
      await this.writeSession(session);
      this.wake(key);
      return { session: { ...session, pending: queue.length }, comments: queue };
    });
  }

  /** End a session without queueing anything further. */
  async end(key: string, by: ReviewEndedBy): Promise<ReviewSession> {
    return this.lock(key, async () => {
      const session = await this.readSession(key);
      session.status = "ended";
      session.endedBy = by;
      session.updated = new Date().toISOString();
      await this.writeSession(session);
      this.wake(key);
      return { ...session, pending: (await this.readQueue(key)).length };
    });
  }

  /**
   * Collect and clear the queue, blocking up to `waitMs` for something to
   * arrive. Returns immediately when the queue is non-empty or the session has
   * ended — an ended session hands over its final comments on the first take
   * and reports `ended` with nothing on every take after that.
   */
  async take(key: string, waitMs: number): Promise<PollResult> {
    const deadline = Date.now() + Math.max(0, waitMs);

    const attempt = (): Promise<PollResult | null> =>
      this.lock(key, async () => {
        const session = await this.readSession(key);
        const queue = await this.readQueue(key);
        if (queue.length === 0 && session.status !== "ended") return null;
        if (queue.length > 0) await this.writeQueue(key, []);
        return { key, status: session.status, comments: queue, timedOut: false };
      });

    for (;;) {
      const remaining = deadline - Date.now();
      // Register interest *before* looking at the queue: `attempt` is async, and
      // a post landing in that window would otherwise wake nobody and leave this
      // poller parked until its deadline.
      const parked = remaining > 0 ? this.park(key, remaining) : null;
      const got = await attempt();
      if (got) {
        parked?.cancel();
        return got;
      }
      if (!parked) {
        // Report the status the caller would see, without consuming anything.
        const session = await this.readSession(key);
        return { key, status: session.status, comments: [], timedOut: true };
      }
      await parked.promise;
    }
  }

  /** Park until this session is woken, or `ms` elapses; cancellable. */
  private park(key: string, ms: number): { promise: Promise<void>; cancel: () => void } {
    let set = this.waiters.get(key);
    if (!set) {
      set = new Set();
      this.waiters.set(key, set);
    }
    const waiters = set;
    let release = (): void => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = (): void => {
      clearTimeout(timer);
      waiters.delete(done);
      if (waiters.size === 0) this.waiters.delete(key);
      release();
    };
    const timer = setTimeout(done, ms);
    // Never hold the process open on a parked poller.
    timer.unref?.();
    waiters.add(done);
    return { promise, cancel: done };
  }
}

/** Parse a stored session, filling in anything an older or damaged file lacks. */
function parseSession(key: string, raw: string): StoredSession {
  let v: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    v = parsed as Record<string, unknown>;
  } catch {
    throw new NotFoundError(`unreadable session ${key}`);
  }
  const file = typeof v.file === "string" ? v.file : "";
  if (!file) throw new NotFoundError(`session ${key} has no file`);
  const now = new Date().toISOString();
  const status = v.status === "ended" ? "ended" : "open";
  const s: StoredSession = {
    key,
    label: typeof v.label === "string" && v.label ? v.label : path.basename(file),
    file,
    created: typeof v.created === "string" ? v.created : now,
    updated: typeof v.updated === "string" ? v.updated : now,
    status,
  };
  if (status === "ended" && (v.endedBy === "agent" || v.endedBy === "human")) s.endedBy = v.endedBy;
  return s;
}

/** Write via a temp file and rename, so a reader never sees half a file. */
async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, file);
}

/** Make the store's root, so the first open does not race on mkdir. */
export function ensureReviewRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true });
}
