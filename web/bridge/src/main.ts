import { loadConfig } from "./config.js";
import { ensureServer } from "./herdr/supervisor.js";
import { SessionHub } from "./herdr/session.js";
import { buildApp } from "./app.js";
import { PortsWatcher } from "./ports.js";
import { ensureReviewRoot } from "./review/store.js";

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

  // Ports that belong to the sandbox's own services, flagged so the UI can tell
  // infrastructure apart from the dev servers an agent starts.
  const systemPorts = [config.port, 8080, 7681, 7682, 7683];
  // Only ports opened by a process running under the workspace root auto-preview;
  // host daemons sharing the namespace (systemd-resolved on :53, etc.) are
  // classified as infrastructure so the app does not open onto them.
  const ports = new PortsWatcher({ systemPorts, workspaceRoot: config.workspaceRoot });

  // Review sessions persist on the home volume; make the root up front so the
  // first `agentbox-review open` is not also the first mkdir.
  ensureReviewRoot(config.reviewDir);

  const app = await buildApp(config, { hub, ports });
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
        ports.stop();
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
