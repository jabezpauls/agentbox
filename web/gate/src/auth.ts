import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { readCookie, SESSION_COOKIE } from "./cookies.js";
import type { SessionRecord, Store, TokenRecord } from "./store.js";

/**
 * Who is asking: a browser session or a device token, looked up in the gate's
 * store and nowhere else.
 */

/** A session left alone this long ends (unless "remember this device" was ticked). */
export const IDLE_MS = 12 * 60 * 60_000;
/** No session outlives this, remembered or not. */
export const ABSOLUTE_MS = 30 * 24 * 60 * 60_000;
/** Bookkeeping writes (last seen, last used) at most this often per credential. */
const TOUCH_MS = 60_000;
const MAX_SESSIONS = 50;
const MAX_TOKENS = 100;

export type Subject =
  | { kind: "session"; id: string; session: SessionRecord }
  | { kind: "token"; id: string; token: TokenRecord };

export const TOKEN_PREFIX = "abx_";
const TOKEN_SHAPE = /^abx_[A-Za-z0-9_-]{43}$/;
const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function digest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** 256 random bits, URL-safe. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function newId(): string {
  return randomBytes(12).toString("hex");
}

/** The bearer token in an `Authorization` header, if that is what it carries. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? (m[1] as string) : null;
}

export class Auth {
  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The session or token a request carries, or `null`. A bearer token is only
   * ever a token: an `Authorization: Basic` header (a browser still holding the
   * old proxy login, say) is not a credential here and does not hide a valid
   * session cookie.
   */
  authenticate(req: IncomingMessage, ip: string): Subject | null {
    const bearer = bearerToken(req.headers.authorization);
    if (bearer !== null) {
      const token = this.token(bearer, ip);
      return token ? { kind: "token", id: token.id, token } : null;
    }
    const secret = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (secret === null) return null;
    const session = this.session(secret, ip);
    return session ? { kind: "session", id: session.id, session } : null;
  }

  isLive(s: SessionRecord): boolean {
    const t = this.now();
    if (t >= s.expiresAt) return false;
    return s.remember || t - s.lastSeenAt < IDLE_MS;
  }

  /** The live session for a cookie secret, touched as seen. */
  private session(secret: string, ip: string): SessionRecord | null {
    if (!SECRET_SHAPE.test(secret)) return null;
    const hash = digest(secret);
    const s = this.store.data.sessions.find((x) => x.hash === hash);
    if (!s || !this.isLive(s)) return null;
    const t = this.now();
    if (t - s.lastSeenAt >= TOUCH_MS || s.ip !== ip) {
      s.lastSeenAt = t;
      s.ip = ip;
      this.store.saveSoon();
    }
    return s;
  }

  private token(raw: string, ip: string): TokenRecord | null {
    if (!TOKEN_SHAPE.test(raw)) return null;
    const hash = digest(raw);
    const tok = this.store.data.tokens.find((x) => x.hash === hash);
    if (!tok) return null;
    const t = this.now();
    if (tok.lastUsedAt === null || t - tok.lastUsedAt >= TOUCH_MS || tok.lastIp !== ip) {
      tok.lastUsedAt = t;
      tok.lastIp = ip;
      this.store.saveSoon();
    }
    return tok;
  }

  async createSession(opts: { remember: boolean; ip: string; userAgent: string }): Promise<{
    secret: string;
    session: SessionRecord;
  }> {
    const t = this.now();
    const secret = newSecret();
    const session: SessionRecord = {
      id: newId(),
      hash: digest(secret),
      createdAt: t,
      lastSeenAt: t,
      expiresAt: t + ABSOLUTE_MS,
      remember: opts.remember,
      ip: opts.ip,
      userAgent: opts.userAgent.slice(0, 300),
    };
    const live = this.store.data.sessions.filter((s) => this.isLive(s));
    // A cap, so a script that logs in in a loop cannot grow the store without
    // bound; the least recently used go first.
    live.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    this.store.data.sessions = [session, ...live.slice(0, MAX_SESSIONS - 1)];
    await this.store.save();
    return { secret, session };
  }

  listSessions(): SessionRecord[] {
    return this.store.data.sessions.filter((s) => this.isLive(s));
  }

  async endSession(id: string): Promise<boolean> {
    const before = this.store.data.sessions.length;
    this.store.data.sessions = this.store.data.sessions.filter((s) => s.id !== id);
    if (this.store.data.sessions.length === before) return false;
    await this.store.save();
    return true;
  }

  /** End every session but `keep` (every session when omitted). Returns how many ended. */
  async endSessions(keep?: string): Promise<number> {
    const before = this.store.data.sessions.length;
    this.store.data.sessions = this.store.data.sessions.filter((s) => s.id === keep);
    await this.store.save();
    return before - this.store.data.sessions.length;
  }

  async createToken(name: string): Promise<{ token: string; record: TokenRecord }> {
    if (this.store.data.tokens.length >= MAX_TOKENS) {
      throw new Error(`at most ${MAX_TOKENS} device tokens; revoke one first`);
    }
    const token = `${TOKEN_PREFIX}${newSecret()}`;
    const record: TokenRecord = {
      id: newId(),
      name: name.slice(0, 100),
      hash: digest(token),
      createdAt: this.now(),
      lastUsedAt: null,
      lastIp: null,
    };
    this.store.data.tokens.push(record);
    await this.store.save();
    return { token, record };
  }

  listTokens(): TokenRecord[] {
    return this.store.data.tokens;
  }

  async revokeToken(id: string): Promise<boolean> {
    const before = this.store.data.tokens.length;
    this.store.data.tokens = this.store.data.tokens.filter((t) => t.id !== id);
    if (this.store.data.tokens.length === before) return false;
    await this.store.save();
    return true;
  }

  async revokeAllTokens(): Promise<number> {
    const n = this.store.data.tokens.length;
    this.store.data.tokens = [];
    await this.store.save();
    return n;
  }

  /** Drop sessions that can no longer be used; called on a timer. */
  async prune(): Promise<void> {
    const before = this.store.data.sessions.length;
    this.store.data.sessions = this.store.data.sessions.filter((s) => this.isLive(s));
    if (this.store.data.sessions.length !== before) await this.store.save();
  }
}
