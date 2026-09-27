/**
 * The raw-path guard, ported from the bridge (`web/bridge/src/path-guard.ts`)
 * so the gate judges the exact string it routes on.
 *
 * Caddy, the gate and every upstream parse a request path, and they do not all
 * normalise it the same way: one decodes `%2f` or resolves `..` before matching,
 * another routes on the raw bytes. A path that reads as `/login` to one parser
 * and `/terminal/` to the next is how an unauthenticated route turns into an
 * authenticated one. So any raw path carrying a form that two parsers could
 * read differently — a dot-segment, `%2e`, `%2f`, `%5c`, a backslash, `;` or
 * `//` — is refused before routing, and no normalisation difference can move a
 * request between branches of the route table.
 */
const AMBIGUOUS = /(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\|;|\/\//i;

/** A request target split at the first `?`, both halves still raw. */
export interface RawTarget {
  path: string;
  /** Everything after the `?`, without it; `null` when there was no `?`. */
  query: string | null;
}

export function splitTarget(url: string): RawTarget {
  const q = url.indexOf("?");
  return q === -1 ? { path: url, query: null } : { path: url.slice(0, q), query: url.slice(q + 1) };
}

/**
 * The bridge's WebDAV mount. WebDAV names files in its path, and a filename
 * may hold `;`, a backslash, `%` — anything but `/` and NUL — so a Finder or
 * rclone request for such a file carries exactly the forms the guard refuses.
 * Under this prefix only the prefix itself is held to the strict form: the
 * route table sends everything beneath it to the bridge, raw and to nowhere
 * else, and the bridge's WebDAV handler decodes each segment itself and
 * refuses `.`, `..`, encoded slashes and NUL before a path reaches the
 * filesystem. So no reading of such a path can land anywhere but there.
 */
export const DAV_PREFIX = "/api/dav";

/** True when `path` is the WebDAV mount or lies beneath it. */
export function isDavPath(path: string): boolean {
  return path === DAV_PREFIX || path.startsWith(`${DAV_PREFIX}/`);
}

/**
 * True when a raw path may be routed. Origin-form only: an absolute-form
 * target (`GET http://host/x`) or `*` is not something a browser or the proxy
 * sends, so it is refused rather than interpreted.
 */
export function isRoutablePath(path: string): boolean {
  if (isDavPath(path) || isAppPath(path)) return true;
  return isStrictPath(path);
}

/**
 * An app's path, `/a/<id>/…`. Below its prefix, a path is the app's own — an
 * app may well use `%2F` or `;` in its URLs — and it goes to the bridge's data
 * plane, raw, and nowhere else: the data plane reads only its own prefix
 * (`/app/<port>/`) and hands the rest to the app on that port. So, as under
 * the WebDAV mount, only the prefix is held to the strict form, and only when
 * the id is well formed; anything else is judged whole.
 */
const APP_PATH = /^\/a\/[a-z2-7]{26}(\/|$)/;

export function isAppPath(path: string): boolean {
  return APP_PATH.test(path);
}

/** The strict form alone, with no exemption: for a path that is somewhere to land rather than a filename. */
export function isStrictPath(path: string): boolean {
  return path.startsWith("/") && !AMBIGUOUS.test(path);
}

/** RFC 3986's unreserved characters, but the dot (see canonicalPath). */
const UNRESERVED = /^[A-Za-z0-9_~-]$/;

/**
 * The path the gate routes on and forwards: `%65` read as `e`, and every other
 * escape of an unreserved character likewise. RFC 3986 makes the two spellings
 * one path, and the bridge's router decodes them — so routed raw,
 * `/ws/%65ditor` would be the editor channel to the bridge and some other path
 * to the route table. Decoded before routing, and forwarded decoded, both read
 * one path. Escapes of anything else stay: a reserved character means
 * something else unescaped, and the guard has already refused the ones that
 * could move a request (`%2f`, `%5c`, `%2e`). The dot stays escaped for the
 * same reason. Under the WebDAV mount and an app's prefix, the path is taken
 * as it came: the names beneath the mount, and an app's own URLs, go as sent.
 */
export function canonicalPath(path: string): string {
  if (isDavPath(path) || isAppPath(path)) return path;
  return path.replace(/%([0-9A-Fa-f]{2})/g, (escape, hex: string) => {
    const c = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(c) ? c : escape;
  });
}
