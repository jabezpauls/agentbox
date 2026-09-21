import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** A share id is a short opaque handle used only in the owner's API and UI. */
export const ID_PATTERN = /^[0-9a-f]{12}$/;
/** A share token is 128 bits of CSPRNG output, rendered as 32 lowercase hex. */
export const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** Default life of a share, extendable by the owner. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** One minted share. `token` is the unguessable public secret; `id` is the
 * owner-facing handle for listing and revoking. */
export interface Share {
  id: string;
  token: string;
  port: number;
  created: string;
  expires: string;
  revoked: boolean;
}

/** What the owner is shown: everything but the raw record shape. */
export interface ShareView {
  id: string;
  token: string;
  port: number;
  created: string;
  expires: string;
}

function isLive(s: Share, now: number): boolean {
  return !s.revoked && Date.parse(s.expires) > now;
}

function toView(s: Share): ShareView {
  return { id: s.id, token: s.token, port: s.port, created: s.created, expires: s.expires };
}

/**
 * The minted public share links, persisted to a single JSON file on the home
 * volume so a link survives a bridge restart. Sharing is low-frequency (an
 * explicit owner action per port), so one file guarded by a serial write lock
 * is simpler and sufficient — no need for the per-key machinery the review
 * store needs for its concurrent long-polls.
 *
 * Security-relevant invariants, matching the design's model:
 *  - a port is never shared until {@link create} is called for it;
 *  - the token is 128 bits from a CSPRNG, so a link is unguessable;
 *  - {@link resolve} returns nothing for an unknown, expired or revoked token,
 *    so a stale or forged link is a plain 404 that reveals nothing;
 *  - {@link revoke} takes effect immediately, on the next resolve.
 */
export class ShareStore {
  private readonly file: string;
  private shares: Share[] | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.file = path.join(root, "shares.json");
  }

  /** Serialise every read-modify-write so two mints never clobber the file. */
  private lock<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private async load(): Promise<Share[]> {
    if (this.shares) return this.shares;
    try {
      const raw = await fsp.readFile(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      this.shares = Array.isArray(parsed) ? parsed.filter(isShare) : [];
    } catch {
      // Missing or corrupt: an empty set is the only safe reading, and the next
      // write replaces the file anyway.
      this.shares = [];
    }
    return this.shares;
  }

  private async persist(shares: Share[]): Promise<void> {
    this.shares = shares;
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(shares, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, this.file);
  }

  /** Mint a share for `port`, pruning dead entries in the same write. */
  async create(port: number): Promise<ShareView> {
    return this.lock(async () => {
      const now = Date.now();
      const live = (await this.load()).filter((s) => isLive(s, now));
      const share: Share = {
        id: randomUUID().replace(/-/g, "").slice(0, 12),
        token: randomBytes(16).toString("hex"),
        port,
        created: new Date(now).toISOString(),
        expires: new Date(now + DEFAULT_TTL_MS).toISOString(),
        revoked: false,
      };
      await this.persist([...live, share]);
      return toView(share);
    });
  }

  /** Every live share, newest first. Dead entries are pruned as a side effect. */
  async list(): Promise<ShareView[]> {
    return this.lock(async () => {
      const now = Date.now();
      const live = (await this.load()).filter((s) => isLive(s, now));
      await this.persist(live);
      return [...live]
        .sort((a, b) => b.created.localeCompare(a.created))
        .map(toView);
    });
  }

  /** The port a live token maps to, or null for unknown/expired/revoked. */
  async resolve(token: string): Promise<number | null> {
    if (!TOKEN_PATTERN.test(token)) return null;
    const now = Date.now();
    const shares = await this.load();
    const hit = shares.find((s) => s.token === token && isLive(s, now));
    return hit ? hit.port : null;
  }

  /** Revoke a share by id; true if one was live to revoke. Immediate. */
  async revoke(id: string): Promise<boolean> {
    return this.lock(async () => {
      const now = Date.now();
      const shares = await this.load();
      const target = shares.find((s) => s.id === id && isLive(s, now));
      // Drop the record entirely — a revoked share reveals nothing and never
      // comes back, and pruning here keeps the file from accreting tombstones.
      const kept = shares.filter((s) => s.id !== id && isLive(s, now));
      await this.persist(kept);
      return target !== undefined;
    });
  }

  /** Push a live share's expiry to a fresh default window; the new view or null. */
  async extend(id: string): Promise<ShareView | null> {
    return this.lock(async () => {
      const now = Date.now();
      const shares = (await this.load()).filter((s) => isLive(s, now));
      const target = shares.find((s) => s.id === id);
      if (!target) return null;
      target.expires = new Date(now + DEFAULT_TTL_MS).toISOString();
      await this.persist(shares);
      return toView(target);
    });
  }
}

function isShare(v: unknown): v is Share {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.token === "string" &&
    typeof s.port === "number" &&
    typeof s.created === "string" &&
    typeof s.expires === "string" &&
    typeof s.revoked === "boolean"
  );
}

/** Make the store's root, so the first mint does not race on mkdir. */
export function ensureSharesRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true });
}
