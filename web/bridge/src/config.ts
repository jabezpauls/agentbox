import os from "node:os"; import path from "node:path";
export interface Config {
  port: number; staticDir: string | null; socketPath: string;
  workspaceRoot: string; reviewDir: string; publicUrl: string | null;
  /**
   * The files API's second root, hidden in the app by default. A separate
   * volume from the workspace, which is why the trash and upload scratch space
   * are kept per root rather than in one place.
   */
  homeRoot: string;
  /**
   * The data plane's listener: apps and tunnels, for the gate alone (see
   * data-plane.ts). 0 turns it off (tests of the control plane alone).
   */
  dataPort: number;
  /** Where the data plane listens: the gate reaches it across the internal network. */
  dataHost: string;
  /** The gate's sandbox-side app API, where the app registry lives. */
  gateAppsUrl: string;
  /**
   * agentbox's own listeners inside the shared namespace: the bridge's two
   * planes, the editor and the three ttyd services. Flagged as system ports
   * in the panel, and never served as apps.
   */
  infraPorts: number[];
  /** The cgroup v2 mount the system view reads the sandbox's limits from. */
  cgroupRoot: string;
  /** What the system view reports as agentbox's version, when the image says. */
  version: string | null;
}
export function defaultSocketPath(env = process.env): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const cfg = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(cfg, "herdr", "herdr.sock");
}
export function loadConfig(env = process.env): Config {
  const port = Number(env.WORKBENCH_PORT ?? 7800);
  const dataPort = Number(env.WORKBENCH_DATA_PORT ?? 7801);
  return {
    port,
    dataPort,
    dataHost: env.WORKBENCH_DATA_HOST ?? "0.0.0.0",
    infraPorts: [port, dataPort, 8080, 7681, 7682, 7683, 2222, 7900, 7901].filter((p) => p > 0),
    staticDir: env.WORKBENCH_STATIC_DIR ?? null, socketPath: defaultSocketPath(env),
    workspaceRoot: env.WORKBENCH_WORKSPACE_ROOT ?? "/workspace",
    homeRoot: env.WORKBENCH_HOME_ROOT ?? (env.HOME || os.homedir()),
    // Review sessions live on the home volume so they survive restarts and
    // updates, which is what lets an agent block on a poll across a redeploy.
    reviewDir: env.WORKBENCH_REVIEW_DIR ?? path.join(env.HOME || os.homedir(), ".agentbox", "review"),
    // The origin a person browses to. Only used to print a clickable link from
    // the CLIs; unset, the bridge falls back to the requesting Host.
    publicUrl: (env.WORKBENCH_PUBLIC_URL || null)?.replace(/\/+$/, "") ?? null,
    gateAppsUrl: (env.AGENTBOX_GATE_APPS_URL || "http://gate:7901").replace(/\/+$/, ""),
    cgroupRoot: env.WORKBENCH_CGROUP_ROOT ?? "/sys/fs/cgroup",
    version: env.AGENTBOX_VERSION || null,
  };
}
