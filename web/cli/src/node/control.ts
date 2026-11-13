import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { writePrivate } from "./paths.js";

/**
 * The node's local control channel, for `status`, `pause`, `resume`, `leave`
 * and `agentbox-preview` (`preview`, `preview-list`, `preview-stop`): a Unix socket in the node's `0700`
 * folder — never TCP. Each request also carries a random secret from a
 * `0600` file beside it, which is what guards a Windows named pipe (whose
 * ACL Node cannot set) and costs nothing here.
 *
 * One JSON line each way: `{"secret","command","args"}` → `{"ok", …}`.
 */

export type ControlCommand = "status" | "pause" | "resume" | "leave" | "preview" | "preview-list" | "preview-stop";
const COMMANDS = new Set<string>(["status", "pause", "resume", "leave", "preview", "preview-list", "preview-stop"]);

export type ControlHandler = (command: ControlCommand, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface ControlServer {
  close(): void;
}

export async function startControl(socketPath: string, secretFile: string, handle: ControlHandler): Promise<ControlServer> {
  const secret = randomBytes(32).toString("base64url");
  writePrivate(secretFile, secret);
  const want = Buffer.from(secret);
  // A socket left by a crashed run would make listen() fail.
  fs.rmSync(socketPath, { force: true });
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
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") fs.chmodSync(socketPath, 0o600);
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
): Promise<Record<string, unknown> | null> {
  let secret: string;
  try {
    secret = fs.readFileSync(secretFile, "utf8").trim();
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
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
