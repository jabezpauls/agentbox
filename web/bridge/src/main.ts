import { loadConfig } from "./config.js";
import { ensureServer } from "./herdr/supervisor.js";
import { SessionHub } from "./herdr/session.js";
import { buildApp } from "./app.js";
import { PortsWatcher } from "./ports.js";
import { ensureReviewRoot } from "./review/store.js";
import { ensureSharesRoot } from "./share/store.js";
import { FilesService } from "./files/service.js";
import { sweepClones } from "./projects.js";

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
  const systemPorts = config.infraPorts;
  // Only ports opened by a process running under the workspace root auto-preview;
  // host daemons sharing the namespace (systemd-resolved on :53, etc.) are
  // classified as infrastructure so the app does not open onto them.
  const ports = new PortsWatcher({ systemPorts, workspaceRoot: config.workspaceRoot });

  // Review sessions persist on the home volume; make the root up front so the
  // first `agentbox-review open` is not also the first mkdir.
  ensureReviewRoot(config.reviewDir);
  // Minted public share links persist here too, for the same reason.
  ensureSharesRoot(config.sharesDir);

  // The files API's roots, trash and uploads. Abandoned uploads are swept here
  // rather than in buildApp, so a test server never touches a real volume.
  const files = new FilesService({ workspaceRoot: config.workspaceRoot, homeRoot: config.homeRoot });
  const stopFiles = files.startMaintenance();
  // A clone cut off by a restart is left in scratch space; clear old ones.
  void sweepClones(config.workspaceRoot).catch(() => {});

  const app = await buildApp(config, { hub, ports, files });
  await app.listen({ host: "0.0.0.0", port: config.port });
  console.log(`[workbench] listening on 0.0.0.0:${config.port}`);

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
        stopFiles();
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
