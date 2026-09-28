import fs from "node:fs";
import path from "node:path";
import { CliError } from "./errors.js";

/**
 * A lock file for a read-modify-write of a small file that several `agentbox`
 * processes may change at once (a `mount` left running while a `login` saves
 * a box): created with O_EXCL, holding the owner's pid, removed when done.
 *
 * A lock left behind by a process that crashed is taken over: when its pid is
 * no longer running, or when it is older than any real change takes. Taking
 * one over is itself done under a second lock, and only after checking again
 * that the lock is the same stale one, so two processes finding it stale at
 * once cannot remove each other's fresh lock. Everything here is synchronous
 * — the changes it guards are a few milliseconds of JSON — so a caller never
 * yields while holding it.
 */

export interface LockOptions {
  /** How long to wait for another process to finish. */
  timeoutMs?: number;
  /** A lock older than this was left behind. */
  staleMs?: number;
}

const WAIT_MS = 10;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** What stands at a lock's path now. */
type LockState = { kind: "gone" } | { kind: "held"; pid: string } | { kind: "stale"; ino: number };

function inspect(lock: string, staleMs: number): LockState {
  let st: fs.Stats;
  let text: string;
  try {
    st = fs.statSync(lock);
    text = fs.readFileSync(lock, "utf8").trim();
  } catch {
    return { kind: "gone" };
  }
  if (Date.now() - st.mtimeMs > staleMs) return { kind: "stale", ino: st.ino };
  const pid = Number(text);
  // Empty: its owner has created it and is about to say who it is.
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return { kind: "stale", ino: st.ino };
    }
  }
  return { kind: "held", pid: text };
}

/** Create `file` exclusively with our pid in it; false when it exists. */
function create(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code === "ENOENT") {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      return create(file);
    }
    throw err;
  }
  try {
    fs.writeSync(fd, `${process.pid}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** Remove the lock if it is still the stale one seen (same inode), under the takeover lock. */
function takeOver(lock: string, ino: number, staleMs: number): void {
  const takeover = `${lock}.takeover`;
  if (!create(takeover)) {
    // Someone else is taking it over, or died doing so long ago.
    if (inspect(takeover, staleMs).kind === "stale") fs.rmSync(takeover, { force: true });
    return;
  }
  try {
    const now = inspect(lock, staleMs);
    if (now.kind === "stale" && now.ino === ino) fs.rmSync(lock, { force: true });
  } finally {
    fs.rmSync(takeover, { force: true });
  }
}

/** Run `fn` holding `<file>.lock`. */
export function withFileLock<T>(file: string, fn: () => T, opts: LockOptions = {}): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  const staleMs = opts.staleMs ?? 30_000;
  while (!create(lock)) {
    const state = inspect(lock, staleMs);
    if (state.kind === "gone") continue;
    if (state.kind === "stale") {
      takeOver(lock, state.ino, staleMs);
      continue;
    }
    if (Date.now() > deadline) {
      throw new CliError(`${file} is being changed by another agentbox${state.pid ? ` (pid ${state.pid})` : ""}; if none is running, remove ${lock}`);
    }
    sleepSync(WAIT_MS);
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
