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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const upstreamHost = env.GATE_UPSTREAM_HOST || "code";
  const upstream = (name: string, fallback: number): Upstream => ({
    host: upstreamHost,
    port: port(env[`GATE_${name}_PORT`], fallback),
  });
  return {
    host: env.GATE_HOST || "0.0.0.0",
    port: port(env.GATE_PORT, 7900),
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
    upstreams: {
      code: upstream("CODE", 8080),
      terminal: upstream("TERMINAL", 7681),
      monitor: upstream("MONITOR", 7682),
      shell: upstream("SHELL", 7683),
      bridge: upstream("BRIDGE", 7800),
    },
    staticDir: env.GATE_STATIC_DIR || path.join(here, "static"),
    cliDir: env.GATE_CLI_DIR || path.join(here, "..", "cli"),
    // Which agentbox this is: the image is built with the checkout's
    // description (see install.sh); a gate run from source says its package.
    version: env.AGENTBOX_VERSION || packageVersion(),
  };
}
