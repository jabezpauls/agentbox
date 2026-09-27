import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A running gate owns its store, and a second writer would be overwritten by
 * its next save. The admin socket only proves that inside one container, but
 * `docker compose run --rm gate agentbox-gate --offline` starts a new one with
 * a /tmp of its own. So the gate also keeps a lease on the volume itself — a
 * small file it rewrites every few seconds and removes on a clean stop — which
 * `--offline` checks from any container that mounts the store.
 */

export const LEASE_FILE = "gate.lease";
const RENEW_MS = 5_000;
/** A lease this old belongs to a gate that is gone (crashed, killed). */
export const LEASE_STALE_MS = 20_000;

export interface Lease {
  host: string;
  pid: number;
  at: number;
}

function write(file: string, now: () => number): void {
  const lease: Lease = { host: os.hostname(), pid: process.pid, at: now() };
  try {
    fs.writeFileSync(file, JSON.stringify(lease), { mode: 0o600 });
  } catch (err) {
    console.error("[gate] could not renew the store lease", err);
  }
}

/** Hold the lease until the returned function is called. */
export function holdLease(dataDir: string, now: () => number = Date.now): () => void {
  const file = path.join(dataDir, LEASE_FILE);
  write(file, now);
  const timer = setInterval(() => write(file, now), RENEW_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    fs.rmSync(file, { force: true });
  };
}

/**
 * The lease of a gate that looks alive, or `null`. A lease that cannot be read
 * whole is treated as alive: the answer that errs is "wait", never "go ahead".
 */
export function liveLease(dataDir: string, now: () => number = Date.now): Lease | { host: "unknown"; pid: 0; at: 0 } | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dataDir, LEASE_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const lease = JSON.parse(text) as Lease;
    if (typeof lease.at !== "number") throw new Error("no time");
    return now() - lease.at < LEASE_STALE_MS ? lease : null;
  } catch {
    return { host: "unknown", pid: 0, at: 0 };
  }
}
