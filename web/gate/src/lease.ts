import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * One writer for the store at a time. A running gate owns its store, and a
 * second writer would be overwritten by its next save; an `--offline` edit
 * (from `docker compose run --rm gate agentbox-gate --offline …`, a container
 * with a /tmp of its own, so the admin socket proves nothing) must not run
 * while a gate does, and a gate must not start in the middle of one.
 *
 * So whoever writes holds a lease on the volume itself: a small file, created
 * exclusively, rewritten every few seconds while held and removed on release.
 * `--offline` refuses while someone else holds it; a starting gate waits for
 * it. A lease not renewed for a while belongs to a writer that is gone
 * (crashed, killed) and is taken over.
 */

export const LEASE_FILE = "gate.lease";
const RENEW_MS = 5_000;
/** A lease this old belongs to a writer that is gone. */
export const LEASE_STALE_MS = 20_000;

export interface Lease {
  host: string;
  pid: number;
  at: number;
  /** Who holds it: the gate, or an offline edit. */
  holder: "gate" | "offline";
}

export class LeaseHeld extends Error {
  constructor(readonly lease: Lease) {
    super(`the store is held by ${lease.holder === "gate" ? "a running gate" : "an offline edit"} (container ${lease.host})`);
  }
}

type Read = { lease: Lease } | { unreadable: true } | null;

function read(file: string): Read {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const lease = JSON.parse(text) as Lease;
    if (typeof lease.at !== "number") throw new Error("no time");
    return { lease };
  } catch {
    // Being written right now, or damaged: treated as held until it goes stale.
    return { unreadable: true };
  }
}

export interface AcquireOptions {
  holder: Lease["holder"];
  /** How long to wait for someone else's lease before giving up; 0 refuses at once. */
  waitMs: number;
  /**
   * A gate restarting in the same container may take over its own lease from
   * before the restart, rather than waiting for it to go stale.
   */
  takeOverOwnHost?: boolean;
  /** Told once, when someone else's lease makes this wait. */
  onWait?: (lease: Lease | null) => void;
  now?: () => number;
}

/** Take the lease on `dataDir`'s store; returns the release. Throws LeaseHeld. */
export async function acquireLease(dataDir: string, opts: AcquireOptions): Promise<() => void> {
  const now = opts.now ?? Date.now;
  const file = path.join(dataDir, LEASE_FILE);
  const mine = (): Lease => ({ host: os.hostname(), pid: process.pid, at: now(), holder: opts.holder });
  const deadline = now() + opts.waitMs;
  let unreadableSince: number | null = null;
  let told = false;
  const waiting = (lease: Lease | null): void => {
    if (!told) opts.onWait?.(lease);
    told = true;
  };

  for (;;) {
    const current = read(file);
    let free = current === null;
    if (current && "lease" in current) {
      const { lease } = current;
      const stale = now() - lease.at >= LEASE_STALE_MS;
      const ownRestart = opts.takeOverOwnHost === true && lease.host === os.hostname() && lease.holder === "gate";
      if (stale || ownRestart) {
        fs.rmSync(file, { force: true });
        free = true;
      } else if (now() >= deadline) {
        throw new LeaseHeld(lease);
      } else {
        waiting(lease);
      }
    } else if (current) {
      unreadableSince ??= now();
      if (now() - unreadableSince >= LEASE_STALE_MS) {
        fs.rmSync(file, { force: true });
        free = true;
      } else if (now() >= deadline) {
        throw new LeaseHeld({ host: "unknown", pid: 0, at: 0, holder: "gate" });
      } else {
        waiting(null);
      }
    }
    if (free) {
      try {
        // Exclusive: of two writers racing for a free lease, one wins.
        fs.writeFileSync(file, JSON.stringify(mine()), { flag: "wx", mode: 0o600 });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        continue;
      }
    }
    await sleep(250);
  }

  const renew = setInterval(() => {
    try {
      fs.writeFileSync(file, JSON.stringify(mine()), { mode: 0o600 });
    } catch (err) {
      console.error("[gate] could not renew the store lease", err);
    }
  }, RENEW_MS);
  renew.unref();
  return () => {
    clearInterval(renew);
    const current = read(file);
    // Only our own lease is ours to remove.
    if (current && "lease" in current && current.lease.host === os.hostname() && current.lease.pid === process.pid) {
      fs.rmSync(file, { force: true });
    }
  };
}
