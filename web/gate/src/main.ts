import { startAdminServer } from "./admin.js";
import { buildGate } from "./app.js";
import { loadConfig } from "./config.js";
import { acquireLease } from "./lease.js";

const USAGE = "Usage: agentbox-gate-server [--help]\n\nRuns agentbox's front door: sign-in, sessions and all request routing.";

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help")) {
    console.log(USAGE);
    return;
  }
  // Everything the gate creates is its own alone: the store, and the admin
  // socket, which would otherwise exist with default permissions for the
  // moment between listen() and chmod().
  process.umask(0o077);
  const config = loadConfig();
  // Taken before the store is opened: from here on, `--offline` in any other
  // container sees that this gate owns it. An offline edit in progress is
  // waited for, so its save is not lost under this gate's first one.
  const releaseLease = await acquireLease(config.dataDir, {
    holder: "gate",
    waitMs: 120_000,
    takeOverOwnHost: true,
    onWait: (lease) =>
      console.log(`[gate] waiting for ${lease?.holder === "offline" ? "an offline edit" : "another gate"} to let go of the store`),
  });
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
      .finally(() => {
        releaseLease();
        process.exit(0);
      });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
