// The app is served at the root of the box's origin, and so is its API
// (`/api/*`) and its sockets (`/ws/*`). Paths are absolute: a deep link such as
// `/files/src/a.ts` must reach the same API as `/` does.
//
// Another build of the app can point all of them (and the gate's app registry
// and the app pages it serves) somewhere else with {@link setApiBase}, e.g.
// `/m/<id>`. The gate's own account API (`/_gate/session` and the rest) stays
// where it is.

let apiBase = "";

/** What every path to the box's API is prefixed with: `""`, the origin's root, by default. */
export function setApiBase(base: string): void {
  apiBase = base.replace(/\/+$/, "");
}

/** The paths {@link apiBase} applies to: the bridge's API and sockets, the app registry, the apps. */
const BASED = /^\/(?:api|ws)(?:[/?]|$)|^\/_gate\/apps(?:[/?]|$)|^\/a\//;

/** An HTTP path to the bridge, e.g. `apiUrl("/api/session")`. */
export function apiUrl(path: string): string {
  return BASED.test(path) ? `${apiBase}${path}` : path;
}

/** A WebSocket URL on this origin, tracking http/https for ws/wss. */
export function wsUrl(path: string): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}${apiUrl(path)}`;
}
