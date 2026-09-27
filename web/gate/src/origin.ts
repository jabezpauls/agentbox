import type { IncomingHttpHeaders } from "node:http";

/**
 * Same-origin checks for requests that carry an ambient credential (the session
 * cookie): cross-site request forgery for state-changing requests, and
 * cross-site WebSocket hijacking for upgrades, which the same-origin policy
 * does not restrain at all.
 *
 * Only the host is compared, as the bridge's WebSocket check does
 * (`web/bridge/src/ws-origin.ts`). The scheme cannot be: TLS ends before the
 * gate, and behind a tunnel or another proxy the browser's `https://host`
 * arrives with a forwarded `http`. Host equality is what carries the weight —
 * anyone who can serve `http://<this host>` to the browser is already in the
 * middle of the connection this protects.
 */

/** True when `Origin` names the request's own `Host`. */
export function originMatchesHost(headers: IncomingHttpHeaders): boolean {
  const origin = headers.origin;
  const host = headers.host;
  if (typeof origin !== "string" || origin === "" || typeof host !== "string" || host === "") return false;
  // `Origin: null` comes from sandboxed documents and privacy redirects; it
  // matches nothing.
  if (origin === "null") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.host.toLowerCase() === host.toLowerCase();
}

/**
 * A state-changing request is ours when its `Origin` is this host, or — when
 * the browser withheld the origin — when it says `Sec-Fetch-Site:
 * same-origin`. A form posted from a page whose referrer policy is
 * `no-referrer` sends `Origin: null` though it is same-origin; a sandboxed or
 * otherwise opaque document sends `Origin: null` too, but with
 * `Sec-Fetch-Site: cross-site`, and no page can set that header itself.
 */
export function isSameOriginRequest(headers: IncomingHttpHeaders): boolean {
  if (originMatchesHost(headers)) return true;
  const withheld = headers.origin === undefined || headers.origin === "null";
  return withheld && headers["sec-fetch-site"] === "same-origin";
}

export function isSafeMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}
