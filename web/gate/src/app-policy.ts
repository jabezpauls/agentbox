import type { IncomingHttpHeaders } from "node:http";
import { setsOurCookie } from "./cookies.js";

/**
 * The app policy's header half: what the gate does to every response that
 * comes back from an app, and the few requests it answers itself. Pure, so
 * each rule can be tested on its own.
 */

/**
 * Every `/a/` response runs in an opaque origin, in the Preview panel and full
 * screen alike, whatever it says for itself: added alongside any policy the
 * app sets, which can only tighten it.
 */
export const APP_SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/** Headers an app may not send the browser as they stand. */
const DROPPED = new Set(["clear-site-data", "strict-transport-security", "service-worker-allowed"]);
/** The gate answers CORS for the app's own origin; an app's own answer for it would contradict it. */
const CORS_RESPONSE = new Set([
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-expose-headers",
]);

/**
 * An app's cookie, scoped to the app: no `Domain` (it could otherwise reach
 * the box's other paths or hosts), its `Path` under `/a/<id>`, and
 * `SameSite=None; Secure`, because every request the app's own page makes is
 * cross-site — its origin is opaque — and a `Lax` cookie would never go with
 * them. So an app's own sign-in works in the panel and when shared.
 */
export function rewriteSetCookie(value: string, prefix: string): string {
  const parts = value.split(";");
  const head = parts.shift() ?? "";
  const kept: string[] = [];
  let path: string | null = null;
  for (const raw of parts) {
    const p = raw.trim();
    if (p === "") continue;
    const name = p.split("=", 1)[0]?.trim().toLowerCase() ?? "";
    if (name === "domain" || name === "samesite" || name === "secure") continue;
    if (name === "path") {
      const v = p.slice(p.indexOf("=") + 1).trim();
      path = v.startsWith("/") ? v : "/";
      continue;
    }
    kept.push(p);
  }
  const out = [head.trim()];
  if (path !== null) out.push(`Path=${path === prefix || path.startsWith(`${prefix}/`) ? path : `${prefix}${path}`}`);
  out.push(...kept, "Secure", "SameSite=None");
  return out.join("; ");
}

/**
 * A redirect that stays inside the app: a root-relative location, or the app's
 * own loopback origin (`http://localhost:5173/x`, which a dev server writes
 * from its own Host), becomes `/a/<id>/x`. Anything else — another site, a
 * relative path, a location already under the prefix — is left alone.
 */
export function rewriteLocation(value: string, prefix: string, port: number): string {
  let path = value;
  const m = /^(?:https?:)?\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d+))?(\/[^?#]*)?(.*)$/i.exec(value);
  if (m) {
    const [, , p, rest = "/", tail = ""] = m as unknown as [string, string, string | undefined, string | undefined, string | undefined];
    if (p !== undefined && Number(p) !== port) return value;
    path = `${rest}${tail}`;
  }
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return value;
  if (path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)) return path;
  return `${prefix}${path}`;
}

export interface PolicyContext {
  /** `/a/<id>`. */
  prefix: string;
  port: number;
  /** The request's `Origin`, if it had one. */
  origin: string | undefined;
}

/**
 * Apply the policy to an app's response headers (already filtered of
 * hop-by-hop headers and the gate's own cookies by the proxy).
 */
export function appResponseHeaders(pairs: Array<[string, string]>, ctx: PolicyContext): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const nullOrigin = ctx.origin === "null";
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (DROPPED.has(lower)) continue;
    if (nullOrigin && CORS_RESPONSE.has(lower)) continue;
    if (lower === "set-cookie") {
      if (setsOurCookie(value)) continue;
      out.push([name, rewriteSetCookie(value, ctx.prefix)]);
      continue;
    }
    if (lower === "location") {
      out.push([name, rewriteLocation(value, ctx.prefix, ctx.port)]);
      continue;
    }
    out.push([name, value]);
  }
  out.push(["Content-Security-Policy", APP_SANDBOX]);
  if (nullOrigin) {
    // The app's own page has an opaque origin, which the browser names
    // `null`: answered as a credentialed CORS request, so module scripts,
    // fetches and fonts load, and every header of the response is readable
    // as it would be from the app's own origin.
    const exposed = [...new Set(out.map(([n]) => n.toLowerCase()))].filter((n) => !n.startsWith("access-control-") && n !== "set-cookie");
    out.push(["Access-Control-Allow-Origin", "null"], ["Access-Control-Allow-Credentials", "true"]);
    if (exposed.length) out.push(["Access-Control-Expose-Headers", exposed.join(", ")]);
    out.push(["Vary", "Origin"]);
  }
  return out;
}

/** A CORS preflight from an app's own page: the gate answers it, for every app alike. */
export function isNullPreflight(method: string | undefined, headers: IncomingHttpHeaders): boolean {
  return method === "OPTIONS" && headers.origin === "null" && typeof headers["access-control-request-method"] === "string";
}

export function preflightHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const method = String(headers["access-control-request-method"] ?? "GET").replace(/[^A-Za-z-]/g, "").slice(0, 32) || "GET";
  const asked = String(headers["access-control-request-headers"] ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => /^[A-Za-z0-9-]{1,64}$/.test(h))
    .slice(0, 50);
  const out: Record<string, string> = {
    "access-control-allow-origin": "null",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": method,
    "access-control-max-age": "600",
    vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    "content-security-policy": APP_SANDBOX,
  };
  if (asked.length) out["access-control-allow-headers"] = asked.join(", ");
  return out;
}

/**
 * Whether a request that changes something may come from where it says. The
 * app's own page sends `Origin: null`; a request from the box's own pages
 * names the box; a client that is not a browser often sends none. A named
 * other site is refused: its forms would otherwise post to a private app on
 * the grant cookie, which has to be `SameSite=None`.
 */
export function appOriginAllowed(headers: IncomingHttpHeaders): boolean {
  const origin = headers.origin;
  if (origin === undefined || origin === "null") return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host.toLowerCase() === String(headers.host ?? "").toLowerCase();
  } catch {
    return false;
  }
}

/** A response type the gate may edit: HTML, or CSS. */
export function editableType(contentType: string | undefined): "html" | "css" | null {
  const t = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (t === "text/html" || t === "application/xhtml+xml") return "html";
  if (t === "text/css") return "css";
  return null;
}

/** A font file, by what the upstream says it is. */
export function isFontType(contentType: string | undefined): boolean {
  const t = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    t.startsWith("font/") ||
    t === "application/font-woff" ||
    t === "application/font-woff2" ||
    t === "application/x-font-woff" ||
    t === "application/x-font-ttf" ||
    t === "application/x-font-otf" ||
    t === "application/x-font-opentype" ||
    t === "application/x-font-truetype" ||
    t === "application/vnd.ms-opentype"
  );
}

export const FONT_PATH = /\.(?:woff2|woff|ttf|otf)$/i;
