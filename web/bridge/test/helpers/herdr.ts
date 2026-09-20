import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

function tmpRoot(): string {
  return fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : os.tmpdir();
}

export function waitForSocket(p: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(p);
      sock.once("connect", () => {
        sock.end();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start >= timeoutMs) {
          reject(new Error(`timed out waiting for socket at ${p}`));
          return;
        }
        setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

export interface TestHerdr {
  socketPath: string;
  env: NodeJS.ProcessEnv;
  dir: string;
  stop(): Promise<void>;
}

export async function startTestHerdr(): Promise<TestHerdr> {
  const dir = fs.mkdtempSync(path.join(tmpRoot(), "wb-"));
  fs.mkdirSync(path.join(dir, "home/.config"), { recursive: true });
  const socketPath = path.join(dir, "h.sock");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(dir, "home"),
    XDG_CONFIG_HOME: path.join(dir, "home/.config"),
    HERDR_SOCKET_PATH: socketPath,
    SHELL: "/bin/bash",
  };

  const child: ChildProcess = spawn("herdr", ["server"], { env, stdio: ["ignore", "pipe", "pipe"] });

  // Always keep at least one "error" listener attached so a spawn/runtime
  // failure (missing binary, EPIPE, ...) becomes a readable rejection or a
  // swallowed post-startup event instead of an uncaught exception that
  // crashes the vitest worker.
  let started = false;
  let startupReject: ((err: Error) => void) | null = null;
  child.on("error", (err) => {
    if (!started && startupReject) {
      startupReject(err);
    }
    // After startup, swallow further errors here; stop()/exit handling below
    // still resolves the process lifecycle.
  });

  const stop = async (): Promise<void> => {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    fs.rmSync(dir, { recursive: true, force: true });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      startupReject = reject;
      waitForSocket(socketPath, 10_000).then(resolve, reject);
    });
  } catch (err) {
    child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  } finally {
    started = true;
    startupReject = null;
  }

  return { socketPath, env, dir, stop };
}
