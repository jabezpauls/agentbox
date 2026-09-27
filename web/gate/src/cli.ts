import { setTimeout as sleep } from "node:timers/promises";
import { AdminError, callAdmin, runAdmin, type AdminCommand } from "./admin.js";
import { Auth } from "./auth.js";
import { loadConfig, type Config } from "./config.js";
import { liveLease } from "./lease.js";
import { hashPassword, passwordProblem } from "./password.js";
import { Store } from "./store.js";

const USAGE = `Usage: agentbox-gate [--offline] <command>

Run inside the gate container; on the host, ./scripts/agentbox wraps it.

  set-password   set the sign-in password (read from stdin); ends every session
  totp-reset     turn two-factor off (lost phone); ends every session
  revoke-all     end every session and revoke every device token
  unlock         clear sign-in rate limits and lockouts
  status         what is configured
  hash-password  print a bcrypt hash of the password on stdin

Commands go to the running gate, which owns the store. --offline edits the
store directly instead, for a stack whose gate is stopped
(docker compose run --rm --no-deps gate agentbox-gate --offline ...); it
refuses while any gate holds the store.`;

const KNOWN: AdminCommand[] = ["set-password", "totp-reset", "revoke-all", "unlock", "status"];

export interface CliIo {
  config: Config;
  /** The password on stdin, for the commands that take one. */
  readPassword: () => Promise<string>;
  /** How long to wait for a gate that is still starting (just after `up -d`). */
  waitMs?: number;
}

/** Run one command; returns what to print. Throws AdminError for the operator's mistakes. */
export async function runCli(argv: string[], io: CliIo): Promise<string> {
  const offline = argv.includes("--offline");
  const [command] = argv.filter((a) => a !== "--offline");
  const { config } = io;

  if (command === "hash-password") {
    const password = await io.readPassword();
    const problem = passwordProblem(password);
    if (problem) throw new AdminError(`password not accepted: ${problem}`);
    return await hashPassword(password, config.bcryptCost);
  }
  if (!KNOWN.includes(command as AdminCommand)) throw new AdminError(`unknown command: ${command}\n\n${USAGE}`);
  const input = command === "set-password" ? { password: await io.readPassword() } : {};

  let out: Record<string, unknown>;
  if (offline) {
    // Only safe when no gate owns the store: its next save would undo ours.
    // The lease on the volume sees a gate in any container; the socket, one
    // in this container.
    const lease = liveLease(config.dataDir);
    if (lease) {
      throw new AdminError(`a gate is running on this store (container ${lease.host}); stop it first, or drop --offline and use docker compose exec`);
    }
    if ((await callAdmin(config.adminSocket, "status")) !== null) {
      throw new AdminError("the gate is running here; drop --offline so it makes the change itself");
    }
    const store = await Store.open(config.dataDir, config.seedPasswordHash);
    out = await runAdmin({ config, store, auth: new Auth(store), now: Date.now }, command as AdminCommand, input);
    await store.flush();
  } else {
    const deadline = Date.now() + (io.waitMs ?? 30_000);
    let answer = await callAdmin(config.adminSocket, command as AdminCommand, input);
    while (answer === null && Date.now() < deadline) {
      await sleep(250);
      answer = await callAdmin(config.adminSocket, command as AdminCommand, input);
    }
    if (answer === null) throw new AdminError("the gate is not answering; if the stack is stopped, use --offline");
    if (answer.status !== 200) throw new AdminError(String(answer.body.error ?? `failed (${answer.status})`));
    out = answer.body;
  }
  return JSON.stringify(out, null, 2);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new AdminError("pipe the password on stdin, e.g. ./scripts/agentbox passwd on the host");
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  // One trailing newline is the pipe's, not the password's.
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function main(argv: string[]): Promise<number> {
  const words = argv.filter((a) => a !== "--offline");
  if (words.length === 0 || words[0] === "--help" || words[0] === "-h") {
    console.log(USAGE);
    return words.length === 0 ? 1 : 0;
  }
  console.log(await runCli(argv, { config: loadConfig(), readPassword: readStdin }));
  return 0;
}

// Run only as the entry point, so tests can import runCli.
if (process.argv[1] && /cli\.(js|ts)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`agentbox-gate: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(err instanceof AdminError ? 2 : 1);
    },
  );
}
