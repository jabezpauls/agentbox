/**
 * The route table: which raw request path goes where. Pure, so the table can be
 * tested exhaustively and read in one place.
 *
 * Every decision is made on the raw path, after the path guard has refused
 * anything two parsers could read differently. Prefixes match whole segments
 * (`/shell` and `/shell/…`, never `/shellfish`), so a route's reach is exactly
 * what its name says.
 */

/** The sandbox services the gate forwards to. All share the `code` namespace. */
export type UpstreamName = "code" | "terminal" | "shell" | "monitor" | "bridge";

export type Route =
  /** Served by the gate's own handlers: login, `/_gate/*`, `/cli/*`, the device page. */
  | { kind: "gate" }
  /** A fixed redirect that needs no authentication and reveals nothing. */
  | { kind: "redirect"; location: string }
  /** Forwarded to a sandbox service; `target` is the raw path and query to request there. */
  | { kind: "upstream"; upstream: UpstreamName; target: string };

/** True when `path` is `prefix` itself or lies beneath it. */
export function underSegment(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Paths the gate answers itself. `/settings/devices` is the device-approval
 * page the CLI's login opens; the gate serves a minimal one until the app's own
 * Settings screen takes the route over.
 */
const GATE_PREFIXES = ["/login", "/_gate", "/cli"];
const GATE_EXACT = new Set(["/settings/devices"]);

/**
 * ttyd serves each shell under its own base path (`--base-path /terminal`), so
 * those paths are forwarded unchanged.
 */
const TTYD: ReadonlyArray<readonly [string, UpstreamName]> = [
  ["/terminal", "terminal"],
  ["/shell", "shell"],
  ["/monitor", "monitor"],
];

/** Where the editor lives. code-server uses relative URLs, so the prefix is stripped. */
export const EDITOR_PREFIX = "/vscode";

export function route(path: string, query: string | null): Route {
  const qs = query === null ? "" : `?${query}`;

  if (GATE_EXACT.has(path) || GATE_PREFIXES.some((p) => underSegment(path, p))) {
    return { kind: "gate" };
  }

  if (path === EDITOR_PREFIX) {
    // code-server resolves its assets relative to the page, so it must be
    // loaded with the trailing slash or every asset lands one level too high.
    return { kind: "redirect", location: `${EDITOR_PREFIX}/${qs}` };
  }
  if (path.startsWith(`${EDITOR_PREFIX}/`)) {
    return { kind: "upstream", upstream: "code", target: `${path.slice(EDITOR_PREFIX.length)}${qs}` };
  }

  for (const [prefix, upstream] of TTYD) {
    if (underSegment(path, prefix)) return { kind: "upstream", upstream, target: `${path}${qs}` };
  }

  // Everything else is the bridge's: the app, its API and its sockets. The path
  // is forwarded untouched, whatever prefix the bridge happens to serve under.
  return { kind: "upstream", upstream: "bridge", target: `${path}${qs}` };
}
