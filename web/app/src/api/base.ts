// The app is served at the root of the box's origin, and so is its API
// (`/api/*`) and its sockets (`/ws/*`). Paths are absolute: a deep link such as
// `/files/src/a.ts` must reach the same API as `/` does.

/** An HTTP path to the bridge, e.g. `apiUrl("/api/session")`. */
export function apiUrl(path: string): string {
  return path;
}

/** A WebSocket URL on this origin, tracking http/https for ws/wss. */
export function wsUrl(path: string): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}${path}`;
}
