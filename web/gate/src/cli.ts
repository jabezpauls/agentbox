import { AdminError, callAdmin, runAdmin, type AdminCommand } from "./admin.js";
import { Auth } from "./auth.js";
import { loadConfig } from "./config.js";
import { hashPassword, passwordProblem } from "./password.js";
import { Store } from "./store.js";

const USAGE = `Usage: agentbox-gate <command>

Run inside the gate container, e.g. docker compose exec -T gate agentbox-gate status.

  set-password   set the sign-in password (read from stdin); ends every session
  totp-reset     turn two-factor off (lost phone); ends every session
  revoke-all     end every session and revoke every device token
  unlock         clear sign-in rate limits and lockouts
  status         what is configured
  hash-password  print a bcrypt hash of the password on stdin`;

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
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const config = loadConfig();

  if (command === "hash-password") {
    const password = await readStdin();
    const problem = passwordProblem(password);
    if (problem) throw new AdminError(`password not accepted: ${problem}`);
    console.log(await hashPassword(password, config.bcryptCost));
    return 0;
  }

  const known: AdminCommand[] = ["set-password", "totp-reset", "revoke-all", "unlock", "status"];
  if (!known.includes(command as AdminCommand)) {
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }
  const input = command === "set-password" ? { password: await readStdin() } : {};

  const answer = await callAdmin(config.adminSocket, command as AdminCommand, input);
  let out: Record<string, unknown>;
  if (answer) {
    if (answer.status !== 200) throw new AdminError(String(answer.body.error ?? `failed (${answer.status})`));
    out = answer.body;
  } else {
    // No gate listening: this is the only writer, so change the file directly.
    const store = await Store.open(config.dataDir, config.seedPasswordHash);
    out = await runAdmin({ config, store, auth: new Auth(store), now: Date.now }, command as AdminCommand, input);
    await store.flush();
    if (command === "unlock") out = { ok: true, note: "the gate is not running; there were no lockouts to clear" };
  }
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`agentbox-gate: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(err instanceof AdminError ? 2 : 1);
  },
);
