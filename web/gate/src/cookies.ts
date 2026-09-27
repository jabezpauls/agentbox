/**
 * The gate's cookie names and the header surgery that keeps them — and every
 * other front-door credential — out of the sandbox.
 */

/** The session. `__Host-`: the browser insists on Secure, Path=/ and no Domain. */
export const SESSION_COOKIE = "__Host-agentbox";
/** An app grant (Phase C), path-scoped to one app. Reserved and stripped from the start. */
export const APP_GRANT_COOKIE = "__Secure-agentbox-app";

const OURS = [SESSION_COOKIE, APP_GRANT_COOKIE].map((n) => n.toLowerCase());

/**
 * True for a cookie name the gate owns. Compared case-insensitively: browsers
 * match the `__Host-`/`__Secure-` prefixes that way, so `__host-agentbox` must
 * not slip past as someone else's cookie.
 */
export function isOurCookie(name: string): boolean {
  return OURS.includes(name.trim().toLowerCase());
}

/** The value of cookie `name` in a `Cookie` header, or `null`. The first wins, as browsers send the most specific first. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The `Cookie` header without the gate's cookies, or `undefined` if nothing is left. */
export function stripOurCookies(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "" && !isOurCookie(p.split("=", 1)[0] ?? ""));
  return kept.length ? kept.join("; ") : undefined;
}

/** True when a `Set-Cookie` value would set one of the gate's cookies. */
export function setsOurCookie(setCookie: string): boolean {
  const eq = setCookie.indexOf("=");
  return eq !== -1 && isOurCookie(setCookie.slice(0, eq));
}

export function sessionCookie(secret: string, maxAgeSeconds: number | null): string {
  const parts = [`${SESSION_COOKIE}=${secret}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax"];
  if (maxAgeSeconds !== null) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join("; ");
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
