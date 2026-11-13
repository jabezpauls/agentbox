import type { IncomingMessage } from "node:http";
import { MACHINES_HEADERS } from "./headers.js";

/**
 * A machine's answers reach the browser only through the gate, which rebuilds
 * their headers (the design, "Responses from a machine"): a machine may be
 * compromised or impersonated, and must not get to set anything on the
 * machines origin — a cookie, a redirect, a CORS grant, a policy of its own —
 * nor serve it a page.
 *
 * - `Content-Type` only from the allowlist; `Content-Length`,
 *   `Content-Range`, `ETag`, `Last-Modified`, `Cache-Control` kept; a
 *   download always `Content-Disposition: attachment`;
 * - every other header dropped, and the machines origin's own added, with
 *   `Content-Security-Policy: sandbox; default-src 'none'`;
 * - anything else — an HTML body, any other type, a redirect — refused
 *   (`null`), which the gate answers with a 502.
 *
 * A WebSocket's `101` keeps what the handshake needs, and nothing else.
 */

export const MACHINE_CSP = "sandbox; default-src 'none'";

/** The allowed media types, by their normalized form, and how they are sent on. */
const TYPES: Record<string, string> = {
  "application/json": "application/json",
  "application/json;charset=utf-8": "application/json",
  "application/octet-stream": "application/octet-stream",
  "text/plain;charset=utf-8": "text/plain; charset=utf-8",
};

const KEPT = new Set(["content-length", "content-range", "etag", "last-modified", "cache-control"]);
const HANDSHAKE = new Set(["upgrade", "connection", "sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"]);

/** `Content-Type` as the allowlist knows it: lower case, no spaces, quotes off the charset. */
export function normalizeType(v: string): string {
  return v
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/charset="([^"]*)"/, "charset=$1");
}

/** A download's file name, if it is a plain one; anything else is dropped. */
function safeFilename(disposition: string): string | null {
  const m = /filename="([^"\\\r\n]{1,200})"/i.exec(disposition) ?? /filename=([^;\s"\\]{1,200})/i.exec(disposition);
  const name = m?.[1];
  return name && /^[\w .()+,@=-]+$/.test(name) && !/^\.+$/.test(name) ? name : null;
}

/** The headers a machine's response goes out with, or `null` to refuse it. */
export function machineResponseHeaders(upstream: IncomingMessage, upgrade: boolean): Array<[string, string]> | null {
  const status = upstream.statusCode ?? 502;
  const raw = upstream.rawHeaders;
  const out: Array<[string, string]> = [];
  let ownCache = false;

  if (upgrade) {
    if (status !== 101) return null;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const lower = (raw[i] as string).toLowerCase();
      if (HANDSHAKE.has(lower)) out.push([raw[i] as string, raw[i + 1] as string]);
    }
  } else {
    // A redirect is refused: a machine must not send the tab anywhere.
    if (status >= 300 && status < 400 && status !== 304) return null;
    if (status < 200 || status > 599) return null;
    const type = upstream.headers["content-type"];
    let sentType: string | null = null;
    if (type !== undefined) {
      sentType = TYPES[normalizeType(type)] ?? null;
      if (sentType === null) return null;
      out.push(["Content-Type", sentType]);
    } else if (status !== 204 && status !== 304 && upstream.headers["content-length"] !== "0") {
      // No type said: bytes, never anything a browser would render.
      sentType = "application/octet-stream";
      out.push(["Content-Type", sentType]);
    }
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const lower = (raw[i] as string).toLowerCase();
      if (!KEPT.has(lower)) continue;
      if (lower === "cache-control") ownCache = true;
      out.push([raw[i] as string, raw[i + 1] as string]);
    }
    const disposition = upstream.headers["content-disposition"];
    if (disposition !== undefined || sentType === "application/octet-stream") {
      const name = disposition ? safeFilename(disposition) : null;
      out.push(["Content-Disposition", name ? `attachment; filename="${name}"` : "attachment"]);
    }
  }
  for (const [n, v] of MACHINES_HEADERS) {
    if (n === "Cache-Control" && ownCache) continue;
    out.push([n, v]);
  }
  out.push(["Content-Security-Policy", MACHINE_CSP]);
  return out;
}
