import { loadConfig } from "./config.js";
import { ensureServer } from "./herdr/supervisor.js";
import { SessionHub } from "./herdr/session.js";
import { request as herdrRequest } from "./herdr/socket.js";
import { buildApp } from "./app.js";
import { PortsWatcher, listListeningPorts } from "./ports.js";
import { ensureReviewRoot } from "./review/store.js";
import { FilesService } from "./files/service.js";
import { sweepClones } from "./projects.js";
import { BridgeEvents } from "./events.js";
import { AppsService } from "./apps/service.js";
import { gateApps } from "./apps/gate.js";
import { createDataPlane } from "./data-plane.js";

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
  // Only ports opened by a process running under the workspace root are
  // offered as apps; host daemons sharing the namespace (systemd-resolved on
  // :53, etc.) are classified as infrastructure.
  const ports = new PortsWatcher({ systemPorts, workspaceRoot: config.workspaceRoot });

  // Review sessions persist on the home volume; make the root up front so the
  // first `agentbox-review open` is not also the first mkdir.
  ensureReviewRoot(config.reviewDir);

  // The files API's roots, trash and uploads. Abandoned uploads are swept here
  // rather than in buildApp, so a test server never touches a real volume.
  const files = new FilesService({ workspaceRoot: config.workspaceRoot, homeRoot: config.homeRoot });
  const stopFiles = files.startMaintenance();
  // A clone cut off by a restart is left in scratch space; clear old ones.
  void sweepClones(config.workspaceRoot).catch(() => {});

  // Apps: the gate's records, what is live of them here, and the launching.
  const events = new BridgeEvents();
  const apps = new AppsService({
    gate: gateApps(config.gateAppsUrl),
    events,
    scanPorts: async () => (await listListeningPorts({ systemPorts, workspaceRoot: config.workspaceRoot })).ports,
    snapshot: () => hub.snapshot(),
    herdr: (method, params) => herdrRequest(config.socketPath, method, params ?? {}),
    herdrReady: () => hub.connected,
  });
  apps.start();
  // A pinned app comes back when the box does: that is what keeps a staging
  // link working across a restart.
  void apps.relaunchPinned().catch((err: unknown) => console.warn("[workbench] relaunching pinned apps failed", err));

  const app = await buildApp(config, { hub, ports, files, events, apps });
  await app.listen({ host: "0.0.0.0", port: config.port });
  console.log(`[workbench] listening on 0.0.0.0:${config.port}`);

  // The data plane: apps and tunnels, for the gate alone.
  const dataPlane = createDataPlane({
    refusedAppPorts: () => new Set(config.infraPorts),
    herdrSocket: config.socketPath,
  });
  if (config.dataPort > 0) {
    await new Promise<void>((resolve, reject) => {
      dataPlane.once("error", reject);
      dataPlane.listen(config.dataPort, config.dataHost, () => {
        dataPlane.off("error", reject);
        resolve();
      });
    });
    console.log(`[workbench] data plane on ${config.dataHost}:${config.dataPort}`);
  }

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[workbench] shutting down");
    dataPlane.closeAllConnections();
    dataPlane.close();
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
