import { randomUUID } from "node:crypto";
import { within } from "../roots.js";

export interface Lock {
  token: string;
  /** The locked resource, as an absolute filesystem path. */
  path: string;
  depth: "0" | "infinity";
  scope: "exclusive" | "shared";
  /** The client's `owner` element, re-serialised, or "". */
  owner: string;
  timeoutS: number;
  expires: number;
}

/** The longest a lock lives without a refresh. Finder refreshes well inside it. */
export const MAX_LOCK_S = 3600;

/** Parse `Timeout: Second-600, Infinite` into seconds, capped. */
export function parseTimeout(header: string | undefined): number {
  if (!header) return MAX_LOCK_S;
  for (const part of header.split(",")) {
    const t = part.trim();
    const m = /^Second-(\d+)$/i.exec(t);
    if (m) return Math.max(1, Math.min(Number(m[1]), MAX_LOCK_S));
    if (/^Infinite$/i.test(t)) return MAX_LOCK_S;
  }
  return MAX_LOCK_S;
}

/**
 * WebDAV write locks, in memory. Locks are advisory coordination between
 * clients — Finder takes one before it writes — so losing them on a restart
 * costs a client a re-lock, nothing more.
 */
export class LockManager {
  private readonly locks = new Map<string, Lock>();

  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    const t = this.now();
    for (const [k, l] of this.locks) if (l.expires <= t) this.locks.delete(k);
  }

  /** Locks whose scope includes `p`: on `p` itself, or depth-infinity above it. */
  covering(p: string): Lock[] {
    this.prune();
    return [...this.locks.values()].filter((l) => l.path === p || (l.depth === "infinity" && within(p, l.path)));
  }

  /** Locks on `p` or anything beneath it. */
  beneath(p: string): Lock[] {
    this.prune();
    return [...this.locks.values()].filter((l) => within(l.path, p));
  }

  get(token: string): Lock | undefined {
    this.prune();
    return this.locks.get(token);
  }

  /**
   * Take a lock, or return the locks it conflicts with. An exclusive lock
   * conflicts with any lock in its way; a shared one only with exclusives.
   */
  acquire(
    p: string,
    opts: { depth: "0" | "infinity"; scope: "exclusive" | "shared"; owner: string; timeoutS: number },
  ): { lock: Lock } | { conflicts: Lock[] } {
    // A depth-infinity lock also collides with anything already locked below.
    const inWay = [...this.covering(p), ...(opts.depth === "infinity" ? this.beneath(p) : [])];
    const unique = [...new Map(inWay.map((l) => [l.token, l])).values()];
    const conflicts = unique.filter((l) => opts.scope === "exclusive" || l.scope === "exclusive");
    if (conflicts.length > 0) return { conflicts };
    const lock: Lock = {
      token: `opaquelocktoken:${randomUUID()}`,
      path: p,
      ...opts,
      expires: this.now() + opts.timeoutS * 1000,
    };
    this.locks.set(lock.token, lock);
    return { lock };
  }

  refresh(token: string, timeoutS: number): Lock | undefined {
    const lock = this.get(token);
    if (!lock) return undefined;
    lock.timeoutS = timeoutS;
    lock.expires = this.now() + timeoutS * 1000;
    return lock;
  }

  release(token: string): boolean {
    return this.locks.delete(token);
  }

  /** Drop every lock on `p` or beneath it (it was deleted or moved away). */
  dropBeneath(p: string): void {
    for (const l of this.beneath(p)) this.locks.delete(l.token);
  }

  /**
   * Whether a write to `paths` may go ahead given the tokens the request
   * submitted: every lock in the way must be one of them (for shared locks,
   * any one of those in the way will do).
   */
  blocked(paths: { path: string; subtree: boolean }[], tokens: Set<string>): Lock | null {
    for (const { path, subtree } of paths) {
      const inWay = subtree ? [...this.covering(path), ...this.beneath(path)] : this.covering(path);
      if (inWay.length === 0) continue;
      const exclusive = inWay.filter((l) => l.scope === "exclusive");
      for (const l of exclusive) if (!tokens.has(l.token)) return l;
      const shared = inWay.filter((l) => l.scope === "shared");
      if (shared.length > 0 && !shared.some((l) => tokens.has(l.token))) return shared[0]!;
    }
    return null;
  }
}

/** One condition in an `If` header list. */
export interface IfCondition {
  not: boolean;
  kind: "token" | "etag";
  value: string;
}

/** One parenthesised list, optionally tagged with the resource it is about. */
export interface IfList {
  resource: string | null;
  conditions: IfCondition[];
}

/**
 * Parse an RFC 4918 `If` header: `(<token> ["etag"]) <http://tagged> (Not <t>)`.
 * Returns null for a header that does not parse.
 */
export function parseIf(header: string): IfList[] | null {
  const lists: IfList[] = [];
  let resource: string | null = null;
  let i = 0;
  const s = header;
  const ws = (): void => {
    while (/\s/.test(s[i] ?? "")) i++;
  };
  for (;;) {
    ws();
    if (i >= s.length) break;
    if (s[i] === "<") {
      const end = s.indexOf(">", i);
      if (end === -1) return null;
      resource = s.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (s[i] !== "(") return null;
    i++;
    const conditions: IfCondition[] = [];
    for (;;) {
      ws();
      if (s[i] === ")") {
        i++;
        break;
      }
      let not = false;
      if (/^not\b/i.test(s.slice(i, i + 4))) {
        not = true;
        i += 3;
        ws();
      }
      if (s[i] === "<") {
        const end = s.indexOf(">", i);
        if (end === -1) return null;
        conditions.push({ not, kind: "token", value: s.slice(i + 1, end) });
        i = end + 1;
      } else if (s[i] === "[") {
        const end = s.indexOf("]", i);
        if (end === -1) return null;
        conditions.push({ not, kind: "etag", value: s.slice(i + 1, end) });
        i = end + 1;
      } else {
        return null;
      }
    }
    if (conditions.length === 0) return null;
    lists.push({ resource, conditions });
  }
  return lists.length > 0 ? lists : null;
}

/** Every state token an `If` header names, for lock checks. */
export function submittedTokens(header: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!header) return out;
  for (const m of header.matchAll(/<([^>]+)>/g)) {
    const t = m[1]!;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) out.add(t);
  }
  return out;
}
