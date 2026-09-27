import fs from "node:fs";
import http from "node:http";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import type { DeviceFlow } from "./device.js";
import { hashPassword, passwordProblem } from "./password.js";
import type { LoginLimiter } from "./ratelimit.js";
import { emptyTotp, type Store } from "./store.js";

/**
 * The host's escape hatches, reached with `docker compose exec gate
 * agentbox-gate …` (which `./scripts/agentbox passwd` and `totp reset` wrap).
 *
 * The running gate owns the store; a second process writing the same file
 * would be overwritten by the gate's next save. So the command talks to the
 * gate over a Unix socket in the gate container's private /tmp — reachable only
 * by a process already inside that container — and the gate makes the change.
 * For a stack whose gate is stopped, `--offline` edits the store itself.
 */

export interface AdminDeps {
  config: Config;
  store: Store;
  auth: Auth;
  devices?: DeviceFlow;
  limiter?: LoginLimiter;
  now: () => number;
}

export type AdminCommand = "set-password" | "totp-reset" | "revoke-all" | "unlock" | "status";

export class AdminError extends Error {}

/** Run one admin command against the store. Every change that decides who gets in ends every session. */
export async function runAdmin(deps: AdminDeps, command: AdminCommand, input: { password?: string } = {}): Promise<Record<string, unknown>> {
  const { store, auth } = deps;
  switch (command) {
    case "set-password": {
      const password = input.password ?? "";
      const problem = passwordProblem(password);
      if (problem) throw new AdminError(`password not accepted: ${problem}`);
      store.data.password = { hash: await hashPassword(password, deps.config.bcryptCost), updatedAt: deps.now() };
      const endedSessions = await auth.endSessions();
      deps.limiter?.reset();
      return { ok: true, endedSessions };
    }
    case "totp-reset": {
      store.data.totp = emptyTotp();
      const endedSessions = await auth.endSessions();
      deps.limiter?.reset();
      return { ok: true, endedSessions };
    }
    case "revoke-all": {
      const endedSessions = await auth.endSessions();
      const revokedTokens = await auth.revokeAllTokens();
      deps.devices?.clear();
      store.data.deviceCodes = [];
      await store.save();
      return { ok: true, endedSessions, revokedTokens };
    }
    case "unlock": {
      deps.limiter?.reset();
      return { ok: true };
    }
    case "status": {
      return {
        passwordSet: store.data.password !== null,
        passwordUpdatedAt: store.data.password?.updatedAt ?? null,
        twoFactor: store.data.totp.secret !== null,
        recoveryCodesLeft: store.data.totp.recoveryCodes.length,
        sessions: auth.listSessions().length,
        tokens: auth.listTokens().length,
      };
    }
  }
}

const COMMANDS = new Set<AdminCommand>(["set-password", "totp-reset", "revoke-all", "unlock", "status"]);

/** Serve the admin commands on a Unix socket only the gate's own user can open. */
export async function startAdminServer(socketPath: string, deps: AdminDeps): Promise<http.Server> {
  // A socket file left by a crashed run would make listen() fail.
  fs.rmSync(socketPath, { force: true });
  const server = http.createServer((req, res) => {
    const command = (req.url ?? "").replace(/^\//, "") as AdminCommand;
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 16 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method !== "POST" || !COMMANDS.has(command)) return reply(404, { error: "unknown command" });
      let input: { password?: string } = {};
      try {
        input = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { password?: string }) : {};
      } catch {
        return reply(400, { error: "bad request" });
      }
      runAdmin(deps, command, input).then(
        (out) => {
          console.log(`[gate] admin: ${command}`);
          reply(200, out);
        },
        (err: unknown) => reply(err instanceof AdminError ? 400 : 500, { error: err instanceof Error ? err.message : String(err) }),
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
  fs.chmodSync(socketPath, 0o600);
  return server;
}

/** Ask the running gate to run a command; `null` when no gate is listening. */
export function callAdmin(socketPath: string, command: AdminCommand, input: object = {}): Promise<{ status: number; body: Record<string, unknown> } | null> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(input);
    const req = http.request(
      { socketPath, path: `/${command}`, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 500, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") resolve(null);
      else reject(err);
    });
    req.end(payload);
  });
}
