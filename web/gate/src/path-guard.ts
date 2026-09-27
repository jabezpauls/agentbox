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
 * True when a raw path may be routed. Origin-form only: an absolute-form
 * target (`GET http://host/x`) or `*` is not something a browser or the proxy
 * sends, so it is refused rather than interpreted.
 */
export function isRoutablePath(path: string): boolean {
  return path.startsWith("/") && !AMBIGUOUS.test(path);
}
