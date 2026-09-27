import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { APP_GRANT_COOKIE } from "./cookies.js";
import type { Store } from "./store.js";

/**
 * App grants: what lets an app's own requests in once its page has loaded.
 *
 * An app's page runs with an opaque origin (the app policy's CSP sandbox), so
 * every request it makes is cross-site: the session cookie (`SameSite=Lax`)
 * never goes with them. So when the owner opens an app — a navigation, which
 * does carry the session — or a visitor types its passcode, the gate mints a
 * grant: cookie `__Secure-agentbox-app`, `Path=/a/<id>/; HttpOnly; Secure;
 * SameSite=None`, scoped to that one app and good for nothing else.
 *
 * The value is `v1.<appId>.<subject>.<exp>.<mac>`, HMAC-SHA256 under a key in
 * the gate's store. The subject is what it was minted from — `s-<session>`,
 * `t-<token>` or `p-<epoch>` for a passcode — and a grant is only as good as
 * its subject still is: an ended session, a revoked token, or a passcode that
 * has changed (a new epoch) voids every grant minted from it.
 */

export type GrantSubject =
  | { kind: "session"; id: string }
  | { kind: "token"; id: string }
  | { kind: "passcode"; epoch: number };

export interface Grant {
  appId: string;
  subject: GrantSubject;
  /** Milliseconds. */
  expiresAt: number;
}

/** A grant from a session or a token lasts this long, and is minted again on the next page load. */
export const OWNER_GRANT_MS = 12 * 60 * 60_000;
/** A passcode unlocks for this long at most (less, when the link ends first). */
export const PASSCODE_GRANT_MS = 7 * 24 * 60 * 60_000;

function subjectText(s: GrantSubject): string {
  switch (s.kind) {
    case "session":
      return `s-${s.id}`;
    case "token":
      return `t-${s.id}`;
    case "passcode":
      return `p-${s.epoch}`;
  }
}

function parseSubject(raw: string): GrantSubject | null {
  const m = /^([stp])-([0-9a-z]{1,64})$/.exec(raw);
  if (!m) return null;
  const [, kind, id] = m as unknown as [string, string, string];
  if (kind === "s") return { kind: "session", id };
  if (kind === "t") return { kind: "token", id };
  if (!/^\d{1,9}$/.test(id)) return null;
  return { kind: "passcode", epoch: Number(id) };
}

export class Grants {
  constructor(private readonly store: Store) {}

  /** The signing key, made and saved on first use. */
  private async key(): Promise<Buffer> {
    if (!this.store.data.appKey) {
      this.store.data.appKey = randomBytes(32).toString("base64url");
      await this.store.save();
    }
    return Buffer.from(this.store.data.appKey, "base64url");
  }

  private keySync(): Buffer | null {
    return this.store.data.appKey ? Buffer.from(this.store.data.appKey, "base64url") : null;
  }

  private static mac(key: Buffer, body: string): string {
    return createHmac("sha256", key).update(body).digest("base64url");
  }

  async mint(grant: Grant): Promise<string> {
    const body = `v1.${grant.appId}.${subjectText(grant.subject)}.${Math.floor(grant.expiresAt / 1000).toString(36)}`;
    return `${body}.${Grants.mac(await this.key(), body)}`;
  }

  /** The grant a cookie value holds, if it is ours, intact and unexpired. Its subject is the caller's to check. */
  verify(value: string, now: number): Grant | null {
    const key = this.keySync();
    if (!key || value.length > 256) return null;
    const parts = value.split(".");
    if (parts.length !== 5 || parts[0] !== "v1") return null;
    const [, appId, subject, exp, mac] = parts as [string, string, string, string, string];
    const expected = Buffer.from(Grants.mac(key, `v1.${appId}.${subject}.${exp}`));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const expiresAt = parseInt(exp, 36) * 1000;
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
    const parsed = parseSubject(subject);
    return parsed ? { appId, subject: parsed, expiresAt } : null;
  }
}

/** The `Set-Cookie` for a grant: this app's path alone, never readable by script. */
export function grantCookie(appId: string, value: string, maxAgeMs: number): string {
  const maxAge = Math.max(1, Math.floor(maxAgeMs / 1000));
  return `${APP_GRANT_COOKIE}=${value}; Path=/a/${appId}/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None`;
}

/** Every value of the grant cookie a request carries (one per path that matched). */
export function grantValues(cookieHeader: string | undefined): string[] {
  if (!cookieHeader) return [];
  const out: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === APP_GRANT_COOKIE) out.push(part.slice(eq + 1).trim());
  }
  return out;
}
