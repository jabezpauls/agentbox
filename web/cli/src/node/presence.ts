import { createHmac, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { CliError } from "../errors.js";
import type { Presence } from "./credentials.js";
import type { Prompter } from "./prompt.js";

/**
 * Presence: the machine itself checks that the owner is at a browser now,
 * with the machines passphrase, before it opens a terminal, agents or files.
 * The gate may be compromised; it cannot answer for the owner.
 *
 * The machines passphrase is typed on this machine's own terminal, never sent
 * anywhere: the node keeps `K = PBKDF2-SHA256(passphrase, salt, 600 000)` and
 * the fresh random salt, which the browser later proves knowledge of with an
 * HMAC under the same `K`. The box never holds either in a form it could
 * replace.
 */

export const PRESENCE_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 12;

export function derive(passphrase: string, salt: Buffer, iterations = PRESENCE_ITERATIONS): Promise<Buffer> {
  return new Promise((resolve, reject) => pbkdf2(passphrase, salt, iterations, 32, "sha256", (err, key) => (err ? reject(err) : resolve(key))));
}

export async function enrol(passphrase: string, now: number, iterations = PRESENCE_ITERATIONS): Promise<Presence> {
  const salt = randomBytes(16);
  const key = await derive(passphrase, salt, iterations);
  return { algorithm: "PBKDF2-SHA256", iterations, salt: salt.toString("base64url"), key: key.toString("base64url"), createdAt: now };
}

/** Ask for the machines passphrase twice, with no echo. */
export async function askPassphrase(prompt: Prompter, err: (s: string) => void): Promise<string> {
  err("The machines passphrase (the one set on the box's host with `agentbox machines enable`).\n");
  err("This machine keeps only a key derived from it; the box never sees it from here.\n");
  const pass = await prompt.secret("Machines passphrase: ");
  if (pass.length < MIN_PASSPHRASE_LENGTH) throw new CliError(`the machines passphrase has at least ${MIN_PASSPHRASE_LENGTH} characters`);
  const again = await prompt.secret("Again: ");
  if (again !== pass) throw new CliError("the passphrases did not match");
  return pass;
}

/** A challenge answers once, within this. */
export const CHALLENGE_MS = 60_000;
/** A grant ends after this long with no channel open on it. */
export const GRANT_IDLE_MS = 30 * 60_000;
/** Five wrong answers in ten minutes lock presence here for fifteen. */
export const LOCK_FAILURES = 5;
export const LOCK_WINDOW_MS = 10 * 60_000;
export const LOCK_MS = 15 * 60_000;
const MAX_CHALLENGES = 64;
const MAX_GRANTS = 32;

/**
 * What the browser signs: the challenge's 32 bytes, then the machines session
 * id and the machine id as UTF-8 (both fixed-length ids), with HMAC-SHA256
 * under K, base64url. The machines UI computes the same with WebCrypto
 * (web/app/src/machines/presence.ts).
 */
export function presenceMessage(challenge: Buffer, sessionId: string, machineId: string): Buffer {
  return Buffer.concat([challenge, Buffer.from(sessionId, "utf8"), Buffer.from(machineId, "utf8")]);
}

export function presenceAnswer(key: Buffer, challenge: Buffer, sessionId: string, machineId: string): string {
  return createHmac("sha256", key).update(presenceMessage(challenge, sessionId, machineId)).digest("base64url");
}

export type ChallengeResult = { challenge: string; salt: string; iterations: number; expiresAt: number } | { locked: true; until: number };

export type AnswerResult =
  | { ok: true; grant: string; expiresAt: number }
  | { ok: false; error: "locked"; until: number }
  | { ok: false; error: "expired" | "wrong" | "no_session"; failures?: number };

interface Grant {
  session: string;
  issuedAt: number;
  lastActive: number;
  open: number;
}

export interface PresenceOptions {
  presence: Presence;
  machineId: string;
  /** policy.json's `presenceHours`, read at each check: lowering it shortens live grants too. */
  hours: () => number;
  now?: () => number;
  /** Said on the machine (its log) when presence locks. */
  log?: (line: string) => void;
}

/**
 * Challenges, answers and grants. A challenge is 32 random bytes, for one
 * machines session, valid 60 s, taken by its first answer whatever that
 * answer is. A right answer earns a grant bound to that session, which lasts
 * `presenceHours` from when it was issued, or until 30 minutes pass with no
 * channel open on it. Wrong answers are counted: five in ten minutes lock
 * presence here for fifteen, right answers included.
 */
export class PresenceGate {
  private readonly key: Buffer;
  private readonly challenges = new Map<string, { session: string; expiresAt: number }>();
  private readonly grants = new Map<string, Grant>();
  private failures: number[] = [];
  private lockedUntil = 0;
  private readonly now: () => number;

  constructor(private readonly o: PresenceOptions) {
    this.key = Buffer.from(o.presence.key, "base64url");
    this.now = o.now ?? Date.now;
  }

  /** Locked until this time, or `null`. */
  locked(): number | null {
    return this.lockedUntil > this.now() ? this.lockedUntil : null;
  }

  challenge(session: string | null): ChallengeResult | null {
    if (session === null) return null;
    const until = this.locked();
    if (until !== null) return { locked: true, until };
    const t = this.now();
    for (const [c, v] of this.challenges) if (v.expiresAt <= t) this.challenges.delete(c);
    while (this.challenges.size >= MAX_CHALLENGES) this.challenges.delete(this.challenges.keys().next().value as string);
    const challenge = randomBytes(32).toString("base64url");
    const expiresAt = t + CHALLENGE_MS;
    this.challenges.set(challenge, { session, expiresAt });
    return { challenge, salt: this.o.presence.salt, iterations: this.o.presence.iterations, expiresAt };
  }

  answer(session: string | null, challenge: string, answer: string): AnswerResult {
    if (session === null) return { ok: false, error: "no_session" };
    const until = this.locked();
    if (until !== null) return { ok: false, error: "locked", until };
    const t = this.now();
    const c = this.challenges.get(challenge);
    // Single use: taken by this answer, right or wrong.
    this.challenges.delete(challenge);
    if (!c || c.expiresAt <= t || c.session !== session) return { ok: false, error: "expired" };
    const want = Buffer.from(presenceAnswer(this.key, Buffer.from(challenge, "base64url"), session, this.o.machineId), "base64url");
    const got = Buffer.from(answer, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      this.failures = this.failures.filter((f) => f > t - LOCK_WINDOW_MS);
      this.failures.push(t);
      if (this.failures.length >= LOCK_FAILURES) {
        this.lockedUntil = t + LOCK_MS;
        this.failures = [];
        this.challenges.clear();
        this.o.log?.(`presence: ${LOCK_FAILURES} wrong machines passphrases in ${LOCK_WINDOW_MS / 60_000} minutes; locked for ${LOCK_MS / 60_000} minutes`);
        return { ok: false, error: "locked", until: this.lockedUntil };
      }
      return { ok: false, error: "wrong", failures: this.failures.length };
    }
    this.failures = [];
    while (this.grants.size >= MAX_GRANTS) this.grants.delete(this.grants.keys().next().value as string);
    const grant = `pg_${randomBytes(32).toString("base64url")}`;
    const g: Grant = { session, issuedAt: t, lastActive: t, open: 0 };
    this.grants.set(grant, g);
    return { ok: true, grant, expiresAt: this.expiry(g) };
  }

  private expiry(g: Grant): number {
    return g.issuedAt + this.o.hours() * 60 * 60_000;
  }

  /** Whether `grant` is live for `session` now. */
  check(grant: string | null, session: string | null): boolean {
    if (grant === null || session === null) return false;
    const g = this.grants.get(grant);
    if (!g || g.session !== session) return false;
    const t = this.now();
    if (t >= this.expiry(g) || (g.open === 0 && t - g.lastActive >= GRANT_IDLE_MS)) {
      this.grants.delete(grant);
      return false;
    }
    return true;
  }

  /** A channel opened on `grant`: it does not idle out while open. Returns its release. */
  hold(grant: string): () => void {
    const g = this.grants.get(grant);
    if (!g) return () => {};
    g.open += 1;
    g.lastActive = this.now();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      g.open -= 1;
      g.lastActive = this.now();
    };
  }
}
