import fs from "node:fs";
import http from "node:http";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import type { DeviceFlow } from "./device.js";
import { PassphraseError, clearMachines, setPassphrase } from "./machines/passphrase.js";
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
  /** App passcode attempts, which `unlock` clears too. */
  passcodes?: LoginLimiter;
  /** Machines passphrase attempts, which `unlock` clears too. */
  machinesLimiter?: LoginLimiter;
  now: () => number;
}

export type AdminCommand =
  | "set-password"
  | "totp-reset"
  | "revoke-all"
  | "unlock"
  | "status"
  | "machines-passphrase"
  | "machines-off";

export class AdminError extends Error {}

/** What a command reads: a password, or the machines passphrase, from the host's stdin. */
export interface AdminInput {
  password?: string;
  passphrase?: string;
}

/** Run one admin command against the store. Every change that decides who gets in ends every session. */
export async function runAdmin(deps: AdminDeps, command: AdminCommand, input: AdminInput = {}): Promise<Record<string, unknown>> {
  const { store, auth } = deps;
  switch (command) {
    case "set-password": {
      const password = input.password ?? "";
      const problem = passwordProblem(password);
      if (problem) throw new AdminError(`password not accepted: ${problem}`);
      const hash = await hashPassword(password, deps.config.bcryptCost);
      store.data.password = { hash, updatedAt: deps.now() };
      store.data.generation += 1;
      const endedSessions = await auth.endSessions();
      deps.limiter?.reset();
      // The hash goes back to the host, which keeps .env's seed in step, so
      // restoring the stack's files cannot bring an old password back.
      return { ok: true, endedSessions, hash };
    }
    case "totp-reset": {
      store.data.totp = emptyTotp();
      store.data.generation += 1;
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
      deps.passcodes?.reset();
      deps.machinesLimiter?.reset();
      return { ok: true };
    }
    case "machines-passphrase": {
      // Set while machines may still be off: `agentbox machines enable` sets
      // it before the hostnames go live, so the machines origin never exists
      // without one.
      try {
        const { endedSessions } = await setPassphrase({ store, cost: deps.config.bcryptCost, now: deps.now }, input.passphrase ?? "");
        deps.machinesLimiter?.reset();
        return { ok: true, endedMachinesSessions: endedSessions };
      } catch (err) {
        if (err instanceof PassphraseError) throw new AdminError(err.message);
        throw err;
      }
    }
    case "machines-off": {
      const { endedSessions } = await clearMachines(store);
      return { ok: true, endedMachinesSessions: endedSessions };
    }
    case "status": {
      return {
        passwordSet: store.data.password !== null,
        passwordUpdatedAt: store.data.password?.updatedAt ?? null,
        twoFactor: store.data.totp.secret !== null,
        recoveryCodesLeft: store.data.totp.recoveryCodes.length,
        sessions: auth.listSessions().length,
        tokens: auth.listTokens().length,
        machines: {
          on: deps.config.machinesHost !== null,
          host: deps.config.machinesHost,
          appsHost: deps.config.machineAppsHost,
          passphraseSet: store.data.machines.passphrase !== null,
          passphraseUpdatedAt: store.data.machines.passphrase?.updatedAt ?? null,
          sessions: store.data.machines.sessions.length,
        },
      };
    }
  }
}

const COMMANDS = new Set<AdminCommand>([
  "set-password",
  "totp-reset",
  "revoke-all",
  "unlock",
  "status",
  "machines-passphrase",
  "machines-off",
]);

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
      let input: AdminInput = {};
      try {
        input = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as AdminInput) : {};
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
