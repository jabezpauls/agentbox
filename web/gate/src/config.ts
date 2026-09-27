import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UpstreamName } from "./routes.js";

export interface Upstream {
  host: string;
  port: number;
}

export interface Config {
  /** The public listener, reached by the proxy. */
  host: string;
  port: number;
  /** Where the store lives: the gate's own volume, which the sandbox never mounts. */
  dataDir: string;
  /** The admin channel `agentbox-gate` talks to; a Unix socket inside the gate container. */
  adminSocket: string;
  /** The one login name. */
  user: string;
  /** Seeds a fresh store's password. The store is the source of truth afterwards. */
  seedPasswordHash: string | null;
  /** bcrypt work factor for new hashes (the spec's 14). */
  bcryptCost: number;
  /**
   * The proxy: hostnames or addresses whose connections may speak for the
   * client's address (in `X-Agentbox-Client-IP`, which the proxy computes).
   * Everyone else, the sandbox included, is judged by the address it connects
   * from.
   */
  trustedProxies: string[];
  /** The origin people browse to, for links the gate hands out; `null` derives it per request. */
  publicUrl: string | null;
  upstreams: Record<UpstreamName, Upstream>;
  /**
   * The bridge's data plane: apps and tunnels, and nothing else. A listener of
   * its own, which only the gate talks to, so app content reaches the browser
   * only through the gate's app policy.
   */
  dataPlane: Upstream;
  /** The sandbox-side app API's listener (register, list, change, remove private apps). */
  appsHost: string;
  appsPort: number;
  /**
   * agentbox's own listeners and any the operator adds
   * (`AGENTBOX_INFRA_PORTS`): never an app, whoever asks. Tunnels may reach
   * them — the token holder is the owner.
   */
  infraPorts: number[];
  /** The owner may make apps public (`AGENTBOX_SHARING`, on by default). */
  sharing: boolean;
  /** The login page's stylesheet, script, tokens and font. */
  staticDir: string;
  /** The CLI bundle served under `/cli/`, when there is one. */
  cliDir: string;
  version: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function packageVersion(): string {
  // dist/ and src/ both sit one level below the package root.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function port(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid port: ${raw}`);
  return n;
}

/** agentbox's own listeners: the editor, the three ttyd services, the bridge's two planes, the gate's two sides. */
export const INFRA_PORTS = [8080, 7681, 7682, 7683, 7800, 7801, 7900, 7901];

/** A comma-separated list of ports, as the operator writes it. */
function portList(raw: string | undefined): number[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => port(s, 0));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const upstreamHost = env.GATE_UPSTREAM_HOST || "code";
  const upstream = (name: string, fallback: number): Upstream => ({
    host: upstreamHost,
    port: port(env[`GATE_${name}_PORT`], fallback),
  });
  const upstreams = {
    code: upstream("CODE", 8080),
    terminal: upstream("TERMINAL", 7681),
    monitor: upstream("MONITOR", 7682),
    shell: upstream("SHELL", 7683),
    bridge: upstream("BRIDGE", 7800),
  };
  const dataPlane = upstream("DATA", 7801);
  const gatePort = port(env.GATE_PORT, 7900);
  const appsPort = port(env.GATE_APPS_PORT, 7901);
  // Whatever ports this gate and its upstreams really use count, as well as
  // the defaults: a test or an unusual install moves them.
  const infra = new Set([
    ...INFRA_PORTS,
    ...Object.values(upstreams).map((u) => u.port),
    dataPlane.port,
    gatePort,
    appsPort,
    ...portList(env.AGENTBOX_INFRA_PORTS),
  ]);
  return {
    host: env.GATE_HOST || "0.0.0.0",
    port: gatePort,
    dataDir: env.GATE_DATA_DIR || "/data",
    adminSocket: env.GATE_ADMIN_SOCKET || "/tmp/agentbox-gate.sock",
    user: env.AGENTBOX_USER || "admin",
    seedPasswordHash: env.AGENTBOX_PASSWORD_HASH || null,
    // Not configurable from the environment: a knob that only ever gets turned
    // down. Tests build their Config directly with a cheaper factor.
    bcryptCost: 14,
    trustedProxies: (env.GATE_TRUSTED_PROXIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    publicUrl: (env.AGENTBOX_PUBLIC_URL || null)?.replace(/\/+$/, "") ?? null,
    upstreams,
    dataPlane,
    appsHost: env.GATE_APPS_HOST || "0.0.0.0",
    appsPort,
    infraPorts: [...infra].sort((a, b) => a - b),
    // Anything but an explicit "off" leaves sharing on; the installer's
    // --sharing writes it.
    sharing: (env.AGENTBOX_SHARING ?? "on").trim().toLowerCase() !== "off",
    staticDir: env.GATE_STATIC_DIR || path.join(here, "static"),
    cliDir: env.GATE_CLI_DIR || path.join(here, "..", "cli"),
    // Which agentbox this is: the image is built with the checkout's
    // description (see install.sh); a gate run from source says its package.
    version: env.AGENTBOX_VERSION || packageVersion(),
  };
}
