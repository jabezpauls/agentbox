import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Context } from "../context.js";
import { CliError, EXIT, UsageError } from "../errors.js";
import { safeText } from "../format.js";
import { openTunnel, type TunnelStream } from "../tunnel.js";
import { command, type Command } from "./types.js";

/**
 * herdr, raw: its socket protocol (one JSON object a line, `{id, method,
 * params}` answered by `{id, result}` or `{id, error}`) over the gate's
 * `herdr` tunnel. `call` makes one request; `socket` puts a Unix socket here
 * that speaks to the box's herdr, so herdr's own client and scripts work as
 * if on the box (`HERDR_SOCKET_PATH=<it> herdr`).
 */

/** One request over a tunnel; the parsed answer line. */
export function herdrRequest(tunnel: TunnelStream, method: string, params: unknown): Promise<{ result?: unknown; error?: { code?: string; message?: string } }> {
  return new Promise((resolve, reject) => {
    let buf = "";
    tunnel.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as { result?: unknown; error?: { code?: string; message?: string } });
      } catch {
        reject(new CliError("herdr answered with something that is not JSON"));
      }
      tunnel.destroy();
    });
    tunnel.on("error", reject);
    tunnel.on("end", () => reject(new CliError("the box closed herdr's socket without an answer")));
    tunnel.write(`${JSON.stringify({ id: `cli_${process.pid}`, method, params })}\n`);
  });
}

const call = command({
  path: ["herdr", "call"],
  summary: "one raw herdr RPC, printed as JSON",
  usage: "<method> [params-json]",
  operands: { min: 1, max: 2 },
  json: true,
  details: "e.g. `agentbox herdr call session.snapshot`, `agentbox herdr call pane.list '{}'`. The result is printed as JSON; a herdr error exits 1.",
  async run(ctx, p) {
    let params: unknown = {};
    if (p.operands[1] !== undefined) {
      try {
        params = JSON.parse(p.operands[1]);
      } catch {
        throw new UsageError("params must be JSON, e.g. '{\"pane_id\": \"…\"}'");
      }
    }
    const { client } = await ctx.connect();
    const answer = await herdrRequest(await openTunnel(client, { kind: "herdr" }), p.operands[0] as string, params);
    if (answer.error) throw new CliError(`herdr: ${safeText(answer.error.message ?? answer.error.code ?? "error")}`);
    ctx.printJson(answer.result ?? null);
  },
});

/** Where `herdr socket` listens by default: a folder of this user's own. */
export function defaultSocketPath(env: NodeJS.ProcessEnv, box: string): string {
  const base = env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `agentbox-${process.getuid?.() ?? "user"}`);
  return path.join(base, "agentbox", `herdr-${box}.sock`);
}

async function stale(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", () => resolve(true));
  });
}

const socket = command({
  path: ["herdr", "socket"],
  summary: "a local Unix socket that speaks to the box's herdr",
  usage: "[path]",
  operands: { min: 0, max: 1 },
  json: true,
  ownsInterrupt: true,
  details: "Then `HERDR_SOCKET_PATH=<path> herdr` (or any herdr script) talks to the box. Ctrl-C stops. Not on Windows.",
  async run(ctx: Context, p) {
    if (ctx.platform === "win32") throw new CliError("Windows has no Unix sockets for herdr's client to use; use `agentbox herdr call` or `agentbox attach`", EXIT.USAGE);
    const { name, client } = await ctx.connect();
    // One tunnel first: a box without it, or a refused token, is said now.
    (await openTunnel(client, { kind: "herdr" })).destroy();
    const where = path.resolve(p.operands[0] ?? defaultSocketPath(ctx.env, name));
    fs.mkdirSync(path.dirname(where), { recursive: true, mode: 0o700 });
    if (fs.existsSync(where)) {
      if (!(await stale(where))) throw new CliError(`${where} is in use; stop what serves it, or name another path`);
      fs.rmSync(where, { force: true });
    }
    const server = net.createServer((local) => {
      local.pause();
      openTunnel(client, { kind: "herdr" })
        .then((tunnel) => {
          local.pipe(tunnel).pipe(local);
          local.resume();
          local.on("error", () => tunnel.destroy());
          local.on("close", () => tunnel.destroy());
          tunnel.on("error", (err: Error) => {
            ctx.warn(`herdr: ${err.message}`);
            local.destroy();
          });
          tunnel.on("close", () => local.end());
        })
        .catch((err: Error) => {
          ctx.warn(err.message);
          local.destroy();
        });
    });
    // The socket is the box's herdr for whoever can open it: this user alone.
    const mask = process.umask(0o077);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(where, () => resolve());
      });
    } finally {
      process.umask(mask);
    }
    fs.chmodSync(where, 0o600);
    if (ctx.json) ctx.printJson({ box: name, socket: where });
    else ctx.out(`${where}\n`);
    ctx.err(`herdr on ${name}, here: HERDR_SOCKET_PATH=${where} herdr   (Ctrl-C to stop)\n`);
    try {
      await new Promise<void>((resolve) => {
        if (ctx.abort.signal.aborted) return resolve();
        ctx.abort.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      server.close();
      fs.rmSync(where, { force: true });
    }
  },
});

export const HERDR_COMMANDS: Command[] = [call, socket];
