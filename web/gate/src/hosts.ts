/**
 * Which origin a request is for. Until machines are turned on, the gate routes
 * on the path alone and every `Host` is the box's own, as it always was. With
 * both machines hostnames configured, a request names exactly one of three
 * hosts — the box (`main`), the machines origin, the machine-apps origin — or
 * none, and is refused (`421`) before anything else looks at it.
 *
 * Every gate route says which of the three it serves (`hosts` in its route
 * config, see app.ts); a route that says nothing serves none.
 */

export type HostKind = "main" | "machines" | "machine-apps";

/** The route tags. */
export const MAIN: HostKind[] = ["main"];
export const MACHINES: HostKind[] = ["machines"];

export interface HostNames {
  main: string;
  machines: string;
  machineApps: string;
}

/**
 * A DNS name with at least two labels whose last is not all digits: never an
 * address, never `localhost`. A box reached by IP or `localhost` cannot have
 * machines (the machines origin's cookie is `__Host-`, `Secure`).
 */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isHostname(s: string): boolean {
  return HOSTNAME.test(s);
}

/**
 * The hostname a `Host` header names: lower case, without its port or the
 * root's trailing dot. `null` when it is not a host at all.
 */
export function hostOf(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.exec(header.trim());
  if (!m) return null;
  return (m[1] as string).toLowerCase().replace(/\.$/, "");
}

/**
 * The configured machines hostnames, checked: both or neither, plain
 * hostnames, distinct from each other and from the box's own, which comes from
 * `AGENTBOX_PUBLIC_URL` and must be `https://<hostname>`. Throws on anything
 * else: half a configuration is a mistake to stop on, not a feature to guess.
 */
export function machinesHostsFrom(
  env: NodeJS.ProcessEnv,
  publicUrl: string | null,
): { machinesHost: string | null; machineAppsHost: string | null } {
  const machines = (env.AGENTBOX_MACHINES_HOST ?? "").trim().toLowerCase();
  const apps = (env.AGENTBOX_MACHINE_APPS_HOST ?? "").trim().toLowerCase();
  if (!machines && !apps) return { machinesHost: null, machineAppsHost: null };
  if (!machines || !apps) {
    throw new Error("set both AGENTBOX_MACHINES_HOST and AGENTBOX_MACHINE_APPS_HOST, or neither");
  }
  const main = mainHostOf(publicUrl);
  if (main === null) {
    throw new Error("machines need AGENTBOX_PUBLIC_URL to be https://<the box's hostname>, with no port or path");
  }
  for (const [key, value] of [["AGENTBOX_MACHINES_HOST", machines], ["AGENTBOX_MACHINE_APPS_HOST", apps]] as const) {
    if (!isHostname(value)) throw new Error(`${key} must be a plain hostname, like machines.example.com (got ${JSON.stringify(value)})`);
  }
  if (new Set([main, machines, apps]).size !== 3) {
    throw new Error("the box, AGENTBOX_MACHINES_HOST and AGENTBOX_MACHINE_APPS_HOST must be three different hostnames");
  }
  return { machinesHost: machines, machineAppsHost: apps };
}

function mainHostOf(publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || (url.pathname !== "/" && url.pathname !== "")) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return isHostname(url.hostname) ? url.hostname : null;
}

/** The three hostnames, or `null` while machines are off. */
export function hostNames(config: {
  publicUrl: string | null;
  machinesHost: string | null;
  machineAppsHost: string | null;
}): HostNames | null {
  if (!config.machinesHost || !config.machineAppsHost) return null;
  const main = mainHostOf(config.publicUrl);
  if (main === null) return null;
  return { main, machines: config.machinesHost, machineApps: config.machineAppsHost };
}

/**
 * The origin a `Host` header is for, or `null` (answer `421`). With machines
 * off (`names` null) every request is the box's, whatever it says.
 */
export function classifyHost(host: string | undefined, names: HostNames | null): HostKind | null {
  if (names === null) return "main";
  const h = hostOf(host);
  if (h === names.main) return "main";
  if (h === names.machines) return "machines";
  if (h === names.machineApps) return "machine-apps";
  return null;
}
