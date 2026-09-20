import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { request } from "./socket.js";

export interface Server {
  spawned: boolean;
  stop(): void;
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

  let stopped = false;
  let child: ChildProcess | null = null;
  let respawnDelay = 1000;
  let respawnTimer: NodeJS.Timeout | null = null;

  const startChild = (): void => {
    log("starting herdr server");
    child = spawn("herdr", ["server"], { env, stdio: ["ignore", "inherit", "inherit"] });
    child.once("exit", (code, signal) => {
      child = null;
      if (stopped) return;
      log(`herdr server exited (code=${code ?? "null"} signal=${signal ?? "null"}); respawning in ${respawnDelay}ms`);
      respawnTimer = setTimeout(() => {
        respawnTimer = null;
        if (stopped) return;
        respawnDelay = Math.min(respawnDelay * 2, 30_000);
        startChild();
      }, respawnDelay);
    });
  };

  startChild();
  await waitForSocket(socketPath, 15_000);
  respawnDelay = 1000;
  log("herdr server ready");

  return {
    spawned: true,
    stop: () => {
      stopped = true;
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
