import { randomInt } from "node:crypto";
import { digest, newId, newSecret, type Auth } from "./auth.js";
import type { DeviceCodeRecord, Store } from "./store.js";

/**
 * The device flow (RFC 8628 in shape) that signs the CLI in without it ever
 * seeing the password:
 *
 * 1. the CLI starts a login and gets a secret device code plus a short user
 *    code, and opens `/settings/devices?code=<user code>`;
 * 2. the owner, signed in, sees the device's name and approves;
 * 3. the CLI's next poll collects its token, exactly once.
 *
 * The device code is stored as a digest. The minted token exists in the clear
 * only in this process's memory between approval and collection: a restart in
 * that window costs the CLI a retry, never a token lying in the store.
 */

export const DEVICE_TTL_MS = 10 * 60_000;
export const POLL_INTERVAL_S = 5;
/**
 * Logins waiting at once: per client address, so one address cannot fill the
 * queue and lock the owner's CLI out for ten minutes; and in all, as a bound.
 */
export const MAX_PENDING_PER_CLIENT = 3;
export const MAX_PENDING = 100;

// No vowels, so a code never spells a word, and nothing that reads as another
// character (0/O, 1/I).
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export type PollResult =
  | { token: string }
  | { error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" };

export function newUserCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** `bcdf ghjk`, `BCDF-GHJK` and `bcdfghjk` are the same code; anything else is none. */
export function normalizeUserCode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== 8) return null;
  for (const ch of s) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** A device name as the owner will read it: printable, trimmed, bounded. */
export function cleanDeviceName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  return s === "" ? null : s;
}

export class TooManyPending extends Error {}

export class DeviceFlow {
  private readonly minted = new Map<string, string>();
  private readonly lastPoll = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly auth: Auth,
    private readonly now: () => number = Date.now,
  ) {}

  /** Start a login for a device named `name`, asked for by `ip` (limits count against `key`). */
  async start(
    name: string,
    ip: string,
    key: string = ip,
  ): Promise<{ deviceCode: string; userCode: string; expiresIn: number; interval: number }> {
    await this.prune();
    const pending = this.store.data.deviceCodes.filter((d) => d.status === "pending");
    if (pending.filter((d) => (d.key ?? d.ip) === key).length >= MAX_PENDING_PER_CLIENT) {
      throw new TooManyPending(`${MAX_PENDING_PER_CLIENT} device logins from your address are already waiting; finish or let them expire`);
    }
    if (pending.length >= MAX_PENDING) throw new TooManyPending("too many device logins are waiting; try again later");
    const t = this.now();
    const deviceCode = newSecret();
    let userCode = newUserCode();
    while (this.store.data.deviceCodes.some((d) => d.userCode === userCode)) userCode = newUserCode();
    const record: DeviceCodeRecord = {
      id: newId(),
      hash: digest(deviceCode),
      userCode,
      name,
      createdAt: t,
      expiresAt: t + DEVICE_TTL_MS,
      ip,
      key,
      status: "pending",
      tokenId: null,
    };
    this.store.data.deviceCodes.push(record);
    await this.store.save();
    return { deviceCode, userCode, expiresIn: DEVICE_TTL_MS / 1000, interval: POLL_INTERVAL_S };
  }

  async poll(deviceCode: string): Promise<PollResult> {
    const hash = digest(deviceCode);
    const rec = this.store.data.deviceCodes.find((d) => d.hash === hash);
    const t = this.now();
    if (!rec || rec.expiresAt <= t) {
      if (rec) await this.remove(rec, rec.status === "approved");
      return { error: "expired_token" };
    }
    if (rec.status === "denied") {
      await this.remove(rec);
      return { error: "access_denied" };
    }
    if (rec.status === "approved") {
      const token = this.minted.get(rec.id);
      await this.remove(rec, token === undefined);
      return token === undefined ? { error: "expired_token" } : { token };
    }
    const last = this.lastPoll.get(rec.id);
    this.lastPoll.set(rec.id, t);
    if (last !== undefined && t - last < POLL_INTERVAL_S * 1000) return { error: "slow_down" };
    return { error: "authorization_pending" };
  }

  /** A login still waiting for the owner, by the code the owner was shown. */
  pending(userCode: string): DeviceCodeRecord | null {
    const code = normalizeUserCode(userCode);
    if (code === null) return null;
    const t = this.now();
    return this.store.data.deviceCodes.find((d) => d.userCode === code && d.status === "pending" && d.expiresAt > t) ?? null;
  }

  async approve(userCode: string): Promise<DeviceCodeRecord | null> {
    const rec = this.pending(userCode);
    if (!rec) return null;
    // Claimed before the first await, so a second approval arriving meanwhile
    // finds nothing pending and one code can never mint two tokens.
    rec.status = "approved";
    try {
      const { token, record } = await this.auth.createToken(rec.name);
      rec.tokenId = record.id;
      this.minted.set(rec.id, token);
    } catch (err) {
      rec.status = "pending";
      throw err;
    }
    await this.store.save();
    return rec;
  }

  async deny(userCode: string): Promise<DeviceCodeRecord | null> {
    const rec = this.pending(userCode);
    if (!rec) return null;
    rec.status = "denied";
    await this.store.save();
    return rec;
  }

  /** Drop expired logins, revoking any token that was minted but never collected. */
  async prune(): Promise<void> {
    const t = this.now();
    for (const rec of this.store.data.deviceCodes.filter((d) => d.expiresAt <= t)) {
      await this.remove(rec, rec.status === "approved");
    }
  }

  /** Forget every login in flight (the admin revoke-all). */
  clear(): void {
    this.minted.clear();
    this.lastPoll.clear();
    this.store.data.deviceCodes = [];
  }

  private async remove(rec: DeviceCodeRecord, revokeToken = false): Promise<void> {
    this.store.data.deviceCodes = this.store.data.deviceCodes.filter((d) => d.id !== rec.id);
    this.minted.delete(rec.id);
    this.lastPoll.delete(rec.id);
    if (revokeToken && rec.tokenId) await this.auth.revokeToken(rec.tokenId);
    await this.store.save();
  }
}
