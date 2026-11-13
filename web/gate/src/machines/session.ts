import type { FastifyRequest } from "fastify";
import { digest, newId, newSecret } from "../auth.js";
import { MACHINES_COOKIE, readCookie } from "../cookies.js";
import type { MachinesSessionRecord, Store } from "../store.js";

/**
 * Sessions on the machines origin. Opened only by the sign-in there (a live
 * main session's handoff nonce and the machines passphrase, see routes.ts),
 * carried only by the machines cookie, and accepted nowhere else: the box's
 * own session list never holds one, and a main session, a device token or
 * anything in `Authorization` opens nothing here.
 *
 * Shorter-lived than the box's: 12 hours at most, 30 minutes idle, no
 * "remember". Ended by signing out of machines, by a change of the main
 * password or two-factor or `revoke-all` (Auth.endSessions), by a change of
 * the machines passphrase and by turning machines off (passphrase.ts).
 */

export const MACHINES_ABSOLUTE_MS = 12 * 60 * 60_000;
export const MACHINES_IDLE_MS = 30 * 60_000;
const TOUCH_MS = 60_000;
const MAX_SESSIONS = 10;
const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** What a handler on the machines origin knows about who is asking. */
export interface MachinesSession {
  /** The session's handle (what presence grants will be bound to); not a credential. */
  id: string;
  record: MachinesSessionRecord;
}

export class MachinesSessions {
  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  private get list(): MachinesSessionRecord[] {
    return this.store.data.machines.sessions;
  }

  isLive(s: MachinesSessionRecord): boolean {
    const t = this.now();
    return s.aud === "machines" && t < s.expiresAt && t - s.lastSeenAt < MACHINES_IDLE_MS;
  }

  /** The live session the machines cookie in `cookieHeader` names, touched as seen; `null` otherwise. */
  authenticate(cookieHeader: string | undefined, ip: string): MachinesSession | null {
    const secret = readCookie(cookieHeader, MACHINES_COOKIE);
    if (secret === null || !SECRET_SHAPE.test(secret)) return null;
    const hash = digest(secret);
    const s = this.list.find((x) => x.hash === hash);
    if (!s || !this.isLive(s)) return null;
    const t = this.now();
    if (t - s.lastSeenAt >= TOUCH_MS || s.ip !== ip) {
      s.lastSeenAt = t;
      s.ip = ip;
      this.store.saveSoon();
    }
    return { id: s.id, record: s };
  }

  /** Whether the session with this handle is still live (a WebSocket it opened lasts only as long). */
  liveById(id: string): boolean {
    const s = this.list.find((x) => x.id === id);
    return s !== undefined && this.isLive(s);
  }

  /** Use of the session that carried no cookie: traffic on a WebSocket it opened. */
  touch(id: string): void {
    const s = this.list.find((x) => x.id === id);
    if (!s || !this.isLive(s)) return;
    const t = this.now();
    if (t - s.lastSeenAt < TOUCH_MS) return;
    s.lastSeenAt = t;
    this.store.saveSoon();
  }

  async create(opts:{ ip: string; userAgent: string }): Promise<{ secret: string; record: MachinesSessionRecord }> {
    const t = this.now();
    const secret = newSecret();
    const record: MachinesSessionRecord = {
      aud: "machines",
      id: newId(),
      hash: digest(secret),
      createdAt: t,
      lastSeenAt: t,
      expiresAt: t + MACHINES_ABSOLUTE_MS,
      ip: opts.ip,
      userAgent: opts.userAgent.slice(0, 300),
    };
    const live = this.list.filter((s) => this.isLive(s)).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    this.store.data.machines.sessions = [record, ...live.slice(0, MAX_SESSIONS - 1)];
    await this.store.save();
    return { secret, record };
  }

  async end(id: string): Promise<boolean> {
    const before = this.list.length;
    this.store.data.machines.sessions = this.list.filter((s) => s.id !== id);
    if (this.list.length === before) return false;
    await this.store.save();
    return true;
  }

  async prune(): Promise<void> {
    const kept = this.list.filter((s) => this.isLive(s));
    if (kept.length === this.list.length) return;
    this.store.data.machines.sessions = kept;
    await this.store.save();
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /** The machines session a request on the machines origin carries; always `null` on the box's. */
    machinesSession: MachinesSession | null;
  }
}

/** Thrown by requireMachinesSession; the machines routes answer it with 401. */
export class NoMachinesSession extends Error {
  readonly statusCode = 401;
  constructor() {
    super("sign in to machines first");
  }
}

/**
 * The machines session of a request a machines route is handling, or a 401.
 * For handlers of routes tagged `hosts: MACHINES` (see routes.ts), which have
 * been through the machines origin's hooks.
 */
export function requireMachinesSession(req: FastifyRequest): MachinesSession {
  if (!req.machinesSession) throw new NoMachinesSession();
  return req.machinesSession;
}
