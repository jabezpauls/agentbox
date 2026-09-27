/**
 * The route table: which raw request path goes where. Pure, so the table can be
 * tested exhaustively and read in one place.
 *
 * Every decision is made on the path as the gate received it, after the path
 * guard has refused anything two parsers could read differently and every
 * escaped ordinary character has been read as itself (`/ws/%65ditor` is
 * `/ws/editor`: see canonicalPath) — and that same path is what is forwarded.
 * Prefixes match whole segments (`/shell` and `/shell/…`, never `/shellfish`),
 * so a route's reach is exactly what its name says.
 */
import { isDavPath } from "./path-guard.js";

/** The sandbox services the gate forwards to. All share the `code` namespace. */
export type UpstreamName = "code" | "terminal" | "shell" | "monitor" | "bridge";

export type Route =
  /** Served by the gate's own handlers: login, `/_gate/*`, the CLI's files, the device page. */
  | { kind: "gate" }
  /** A fixed redirect that needs no authentication and reveals nothing. */
  | { kind: "redirect"; location: string }
  /** Not served from outside at all, signed in or not. */
  | { kind: "notFound" }
  /** Forwarded to a sandbox service; `target` is the raw path and query to request there. */
  | { kind: "upstream"; upstream: UpstreamName; target: string };

/** True when `path` is `prefix` itself or lies beneath it. */
export function underSegment(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Paths the gate answers itself. `/settings/devices` is the device-approval
 * page the CLI's login opens; the gate serves a minimal one until the app's own
 * Settings screen takes the route over. The CLI's two files are exact paths,
 * not a prefix: they are served to anyone, so nothing else under `/cli` may
 * ride along.
 */
const GATE_PREFIXES = ["/login", "/_gate"];
const GATE_EXACT = new Set(["/settings/devices", "/cli/install", "/cli/agentbox.mjs"]);

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

/**
 * The bridge's editor channel: the socket the VS Code extension inside the
 * sandbox holds open to receive "Open in editor". It is for that extension
 * alone; a browser, or anything else through the front door, posing as the
 * editor would be sent the files the owner opens. The bridge refuses anything
 * that is not local, and the gate does not forward it at all — under any
 * spelling, since the route table only ever sees the canonical one.
 */
export const EDITOR_CHANNEL = "/ws/editor";

export function route(path: string, query: string | null): Route {
  const qs = query === null ? "" : `?${query}`;

  // Everything under the WebDAV mount goes to the bridge, raw: the path guard
  // lets its filename characters through on that condition (see path-guard.ts).
  if (isDavPath(path)) return { kind: "upstream", upstream: "bridge", target: `${path}${qs}` };

  if (underSegment(path, EDITOR_CHANNEL)) return { kind: "notFound" };

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
