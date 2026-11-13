import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { writePrivate } from "./paths.js";

/**
 * The node's local control channel, for `status`, `pause`, `resume`, `leave`
 * and `agentbox-preview` (`preview`, `preview-list`, `preview-stop`) — never
 * TCP. Each request carries a random secret from an owner-only file in the
 * node's folder, made afresh at each start.
 *
 * - Linux and macOS: a Unix socket in the node's `0700` folder (`control.sock`).
 * - Windows: a named pipe. Its ACL is Windows' default, which Node cannot
 *   change, and its name is global, so it gets a fresh random name at each
 *   start, written to `control.pipe` in the node's folder, and the secret is
 *   what keeps anyone else out (machines spike, question 1).
 *
 * One JSON line each way: `{"secret","command","args"}` → `{"ok", …}`.
 */

export type ControlCommand = "status" | "pause" | "resume" | "leave" | "preview" | "preview-list" | "preview-stop" | "passphrase";
const COMMANDS = new Set<string>(["status", "pause", "resume", "leave", "preview", "preview-list", "preview-stop", "passphrase"]);

export type ControlHandler = (command: ControlCommand, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface ControlServer {
  close(): void;
}

const PIPE_NAME = /^\\\\\.\\pipe\\agentbox-node-[0-9a-f]{32}$/;

/** Where a client connects: the socket, or on Windows the pipe whose name the file holds (`null`: no node). */
function address(socketPath: string, platform: NodeJS.Platform): string | null {
  if (platform !== "win32") return socketPath;
  try {
    const name = fs.readFileSync(socketPath, "utf8").trim();
    return PIPE_NAME.test(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * Listen at `socketPath` (on Windows, the file naming the pipe). The secret
 * is written before anything listens, so no request is ever answered without
 * one.
 */
export async function startControl(socketPath: string, secretFile: string, handle: ControlHandler, platform: NodeJS.Platform = process.platform): Promise<ControlServer> {
  const secret = randomBytes(32).toString("base64url");
  writePrivate(secretFile, secret);
  const want = Buffer.from(secret);
  // A socket (or pipe name) left by a crashed run would make listen() fail, or point nowhere.
  fs.rmSync(socketPath, { force: true });
  const listenAt = platform === "win32" ? `\\\\.\\pipe\\agentbox-node-${randomBytes(16).toString("hex")}` : socketPath;
  const server = net.createServer((sock) => {
    let buf = "";
    sock.setTimeout(10_000, () => sock.destroy());
    sock.on("error", () => sock.destroy());
    sock.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      if (buf.length > 16 * 1024) return sock.destroy();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const reply = (o: Record<string, unknown>): void => {
        sock.end(`${JSON.stringify(o)}\n`);
      };
      let req: { secret?: unknown; command?: unknown; args?: unknown };
      try {
        req = JSON.parse(buf.slice(0, nl)) as typeof req;
      } catch {
        return reply({ ok: false, error: "bad request" });
      }
      const got = Buffer.from(typeof req.secret === "string" ? req.secret : "");
      if (got.length !== want.length || !timingSafeEqual(got, want)) return reply({ ok: false, error: "refused" });
      if (typeof req.command !== "string" || !COMMANDS.has(req.command)) return reply({ ok: false, error: "unknown command" });
      const args = typeof req.args === "object" && req.args !== null && !Array.isArray(req.args) ? (req.args as Record<string, unknown>) : {};
      handle(req.command as ControlCommand, args).then(
        (out) => reply({ ok: true, ...out }),
        (err: unknown) => reply({ ok: false, error: (err as Error).message }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenAt, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (platform === "win32") writePrivate(socketPath, `${listenAt}\n`);
  else fs.chmodSync(socketPath, 0o600);
  return {
    close: () => {
      server.close();
      fs.rmSync(socketPath, { force: true });
    },
  };
}

/** Ask the running node; `null` when none is running. */
export function callControl(
  socketPath: string,
  secretFile: string,
  command: ControlCommand,
  timeoutMs = 10_000,
  args: Record<string, unknown> = {},
  platform: NodeJS.Platform = process.platform,
): Promise<Record<string, unknown> | null> {
  let secret: string;
  try {
    secret = fs.readFileSync(secretFile, "utf8").trim();
  } catch {
    return Promise.resolve(null);
  }
  const at = address(socketPath, platform);
  if (at === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    const sock = net.connect(at);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(null);
    }, timeoutMs);
    sock.on("connect", () => sock.write(`${JSON.stringify({ secret, command, args })}\n`));
    sock.on("data", (c: Buffer) => (buf += c.toString("utf8")));
    sock.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}
