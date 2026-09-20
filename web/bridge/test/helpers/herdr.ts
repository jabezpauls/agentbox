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
  await waitForSocket(socketPath, 10_000);
  return {
    socketPath,
    env,
    dir,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
