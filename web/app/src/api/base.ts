// The app is served under a base path the operator chooses (default
// `/workbench`). One build serves any prefix because every URL is derived from
// the current location at runtime rather than baked in at build time.

/** The first path segment of the current URL, e.g. `/workbench`, or `""` at root. */
export function basePath(): string {
  const first = location.pathname.split("/")[1] ?? "";
  return first ? `/${first}` : "";
}

/** An HTTP path under the base, e.g. `apiUrl("/api/session")`. */
export function apiUrl(path: string): string {
  return `${basePath()}${path}`;
}

/** A WebSocket URL under the base, tracking http/https for ws/wss. */
export function wsUrl(path: string): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}${basePath()}${path}`;
}
