import { loadConfig } from "./config.js";
import { ensureServer } from "./herdr/supervisor.js";
import { SessionHub } from "./herdr/session.js";
import { buildApp } from "./app.js";

const USAGE = "Usage: workbench-bridge [--help]\n\nRuns the Workbench bridge server that proxies browser clients to herdr.";

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const config = loadConfig();
  // Ensure a herdr server is running; it is meant to outlive the bridge, so we
  // never stop it on shutdown.
  await ensureServer(config.socketPath, process.env);

  const hub = new SessionHub(config.socketPath);
  await hub.start();

  const app = await buildApp(config, { hub });
  await app.listen({ host: "0.0.0.0", port: config.port });
  console.log(`[workbench] listening on 0.0.0.0:${config.port}${config.basePath}`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[workbench] shutting down");
    app
      .close()
      .catch(() => {})
      .finally(() => {
        hub.stop();
        process.exit(0);
      });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
