import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { request } from "./socket.js";

export interface Server {
  spawned: boolean;
  stop(): void;
}

/**
 * Exponential respawn backoff with a cap and a reset. `next()` returns the delay
 * to wait before the next respawn and then grows it toward the cap; `reset()`
 * drops it back to the floor, which the supervisor calls once a server has run
 * long enough to be considered healthy so a later isolated crash restarts fast.
 */
export class Backoff {
  private delay: number;
  constructor(
    private readonly initial: number,
    private readonly max: number,
  ) {
    this.delay = initial;
  }
  get value(): number {
    return this.delay;
  }
  grow(): void {
    this.delay = Math.min(this.delay * 2, this.max);
  }
  reset(): void {
    this.delay = this.initial;
  }
}

function log(msg: string): void {
  console.log(`[workbench] ${msg}`);
}

function socketReady(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    sock.once("connect", () => {
      sock.end();
      resolve(true);
    });
    sock.once("error", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await socketReady(socketPath)) return;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`timed out waiting for herdr socket at ${socketPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Ensure a herdr server is answering on `socketPath`. If one already responds to
 * `ping`, do nothing. Otherwise spawn `herdr server`, wait for its socket, and
 * respawn it (with backoff) if it exits unexpectedly until `stop()` is called.
 */
export async function ensureServer(socketPath: string, env: NodeJS.ProcessEnv): Promise<Server> {
  try {
    await request(socketPath, "ping", {}, { timeoutMs: 1500 });
    return { spawned: false, stop: () => {} };
  } catch {
    // No server answered; we start and supervise one below.
  }

  const INITIAL_DELAY = 1000;
  const MAX_DELAY = 30_000;
  // A server that has stayed up this long is considered healthy: the next crash
  // should retry promptly rather than inherit the delay a crash loop had climbed
  // to. Without this, a server that runs for hours then dies waits out the
  // capped backoff before coming back.
  const STABLE_MS = 60_000;

  let stopped = false;
  let child: ChildProcess | null = null;
  const backoff = new Backoff(INITIAL_DELAY, MAX_DELAY);
  let respawnTimer: NodeJS.Timeout | null = null;
  let stableTimer: NodeJS.Timeout | null = null;

  const clearStable = (): void => {
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
  };

  const startChild = (): void => {
    log("starting herdr server");
    // Its own session (setsid): herdr counts only such a server as a detached
    // daemon, and `herdr --remote` / saved machines over SSH refuse any other,
    // offering to restart it — which would end every pane.
    child = spawn("herdr", ["server"], { env, stdio: ["ignore", "inherit", "inherit"], detached: true });
    // Arm the stability reset the moment we spawn; a run that outlasts STABLE_MS
    // clears the accumulated backoff so an isolated later crash restarts fast.
    stableTimer = setTimeout(() => {
      stableTimer = null;
      backoff.reset();
    }, STABLE_MS);
    stableTimer.unref?.();
    child.once("exit", (code, signal) => {
      child = null;
      clearStable();
      if (stopped) return;
      log(`herdr server exited (code=${code ?? "null"} signal=${signal ?? "null"}); respawning in ${backoff.value}ms`);
      respawnTimer = setTimeout(() => {
        respawnTimer = null;
        if (stopped) return;
        backoff.grow();
        startChild();
      }, backoff.value);
    });
  };

  startChild();
  await waitForSocket(socketPath, 15_000);
  backoff.reset();
  log("herdr server ready");

  return {
    spawned: true,
    stop: () => {
      stopped = true;
      clearStable();
      if (respawnTimer) {
        clearTimeout(respawnTimer);
        respawnTimer = null;
      }
      if (child) {
        child.kill("SIGTERM");
        child = null;
      }
    },
  };
}
