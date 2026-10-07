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
  | { kind: "upstream"; upstream: UpstreamName; target: string }
  /** An app, `/a/<id>/…`: the app policy decides (app-access.ts). `rest` starts with `/`. */
  | { kind: "app"; id: string; rest: string; query: string | null }
  /** The CLI's tunnels, WebSocket only, device token only. */
  | { kind: "tunnel" };

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
 * code-server's own port proxy (`/proxy/<port>/`, `/absproxy/<port>/`) would
 * serve any port in the sandbox — an app, or the bridge itself — on the box's
 * origin, outside the app policy. The compose file starts code-server with
 * `--disable-proxy`; the gate refuses these paths as well, in any letter case
 * (code-server's router ignores case), so neither alone is what stands.
 */
const EDITOR_PROXIES = ["/proxy", "/absproxy"];

/**
 * The bridge's editor channel: the socket the VS Code extension inside the
 * sandbox holds open to receive "Open in editor". It is for that extension
 * alone; a browser, or anything else through the front door, posing as the
 * editor would be sent the files the owner opens. The bridge refuses anything
 * that is not local, and the gate does not forward it at all — under any
 * spelling, since the route table only ever sees the canonical one.
 */
export const EDITOR_CHANNEL = "/ws/editor";

/**
 * Where each agent's status line reports its plan usage to the bridge. Only a
 * process in the sandbox may say what the agents are doing, so this is for
 * the sandbox's loopback alone, like the editor channel: the bridge refuses
 * anything that is not local, and the gate does not forward it at all.
 */
export const USAGE_REPORT = "/api/usage/report";

/** Apps: `/a/<id>/…`. */
export const APP_PREFIX = "/a";

/** `GET /_gate/tunnel?target=tcp:<port>|herdr`: a WebSocket the CLI forwards a port or herdr over. */
export const TUNNEL_PATH = "/_gate/tunnel";

export function route(path: string, query: string | null): Route {
  const qs = query === null ? "" : `?${query}`;

  // Everything under the WebDAV mount goes to the bridge, raw: the path guard
  // lets its filename characters through on that condition (see path-guard.ts).
  if (isDavPath(path)) return { kind: "upstream", upstream: "bridge", target: `${path}${qs}` };

  if (underSegment(path, EDITOR_CHANNEL)) return { kind: "notFound" };
  if (underSegment(path, USAGE_REPORT)) return { kind: "notFound" };

  // An app, and nothing but the app: the data plane, under the app policy.
  // The bare `/a/<id>` gets its trailing slash, so the app's relative URLs
  // resolve inside it; that answer is the same for every id, known or not.
  if (underSegment(path, APP_PREFIX)) {
    const m = /^\/a\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return { kind: "notFound" };
    const [, id, rest] = m as unknown as [string, string, string | undefined];
    if (rest === undefined) return { kind: "redirect", location: `${APP_PREFIX}/${id}/${qs}` };
    return { kind: "app", id, rest, query };
  }

  if (path === TUNNEL_PATH) return { kind: "tunnel" };

  if (GATE_EXACT.has(path) || GATE_PREFIXES.some((p) => underSegment(path, p))) {
    return { kind: "gate" };
  }

  if (path === EDITOR_PREFIX) {
    // code-server resolves its assets relative to the page, so it must be
    // loaded with the trailing slash or every asset lands one level too high.
    return { kind: "redirect", location: `${EDITOR_PREFIX}/${qs}` };
  }
  if (path.startsWith(`${EDITOR_PREFIX}/`)) {
    const inner = path.slice(EDITOR_PREFIX.length);
    if (EDITOR_PROXIES.some((p) => underSegment(inner.toLowerCase(), p))) return { kind: "notFound" };
    return { kind: "upstream", upstream: "code", target: `${inner}${qs}` };
  }

  for (const [prefix, upstream] of TTYD) {
    if (underSegment(path, prefix)) return { kind: "upstream", upstream, target: `${path}${qs}` };
  }

  // Everything else is the bridge's: the app, its API and its sockets. The path
  // is forwarded untouched, whatever prefix the bridge happens to serve under.
  return { kind: "upstream", upstream: "bridge", target: `${path}${qs}` };
}
