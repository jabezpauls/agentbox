import { startAdminServer } from "./admin.js";
import { buildGate } from "./app.js";
import { loadConfig } from "./config.js";

const USAGE = "Usage: agentbox-gate-server [--help]\n\nRuns agentbox's front door: sign-in, sessions and all request routing.";

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const config = loadConfig();
  const gate = await buildGate(config);
  await gate.app.listen({ host: config.host, port: config.port });
  const admin = await startAdminServer(config.adminSocket, {
    config,
    store: gate.core.store,
    auth: gate.core.auth,
    devices: gate.core.devices,
    limiter: gate.core.limiter,
    now: gate.core.now,
  });
  console.log(`[gate] listening on ${config.host}:${config.port}`);
  if (!gate.core.store.data.password) {
    console.warn("[gate] no password is set: nobody can sign in. On the host, run ./scripts/agentbox passwd");
  }

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    admin.close();
    gate
      .close()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
