import { randomUUID } from "node:crypto";
import path from "node:path";
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

/** The most locks held at once. Finder holds a few; this is a ceiling, not a budget. */
export const MAX_LOCKS = 1000;

/**
 * WebDAV write locks, in memory. Locks are advisory coordination between
 * clients — Finder takes one before it writes — so losing them on a restart
 * costs a client a re-lock, nothing more.
 *
 * Locks are indexed by path, so the question PROPFIND asks for every member
 * it lists — which locks cover this? — costs a walk up that path, not a scan
 * of every lock; and the table is bounded, so the scans that remain (for a
 * write that affects a whole subtree) stay small.
 */
export class LockManager {
  private readonly byToken = new Map<string, Lock>();
  private readonly byPath = new Map<string, Set<Lock>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly max = MAX_LOCKS,
  ) {}

  get size(): number {
    return this.byToken.size;
  }

  private remove(l: Lock): void {
    this.byToken.delete(l.token);
    const set = this.byPath.get(l.path);
    set?.delete(l);
    if (set && set.size === 0) this.byPath.delete(l.path);
  }

  private live(l: Lock): boolean {
    if (l.expires > this.now()) return true;
    this.remove(l);
    return false;
  }

  private prune(): void {
    for (const l of [...this.byToken.values()]) this.live(l);
  }

  /** Locks whose scope includes `p`: on `p` itself, or depth-infinity above it. */
  covering(p: string): Lock[] {
    const out: Lock[] = [];
    for (let dir = p, first = true; ; first = false) {
      for (const l of [...(this.byPath.get(dir) ?? [])]) {
        if ((first || l.depth === "infinity") && this.live(l)) out.push(l);
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return out;
  }

  /** Locks on `p` or anything beneath it. */
  beneath(p: string): Lock[] {
    return [...this.byToken.values()].filter((l) => within(l.path, p) && this.live(l));
  }

  get(token: string): Lock | undefined {
    const l = this.byToken.get(token);
    return l && this.live(l) ? l : undefined;
  }

  /**
   * Take a lock, or return the locks it conflicts with. An exclusive lock
   * conflicts with any lock in its way; a shared one only with exclusives.
   * `full` when the table is at its ceiling.
   */
  acquire(
    p: string,
    opts: { depth: "0" | "infinity"; scope: "exclusive" | "shared"; owner: string; timeoutS: number },
  ): { lock: Lock } | { conflicts: Lock[] } | { full: true } {
    // A depth-infinity lock also collides with anything already locked below.
    const inWay = [...this.covering(p), ...(opts.depth === "infinity" ? this.beneath(p) : [])];
    const unique = [...new Map(inWay.map((l) => [l.token, l])).values()];
    const conflicts = unique.filter((l) => opts.scope === "exclusive" || l.scope === "exclusive");
    if (conflicts.length > 0) return { conflicts };
    if (this.byToken.size >= this.max) {
      this.prune();
      if (this.byToken.size >= this.max) return { full: true };
    }
    const lock: Lock = {
      token: `opaquelocktoken:${randomUUID()}`,
      path: p,
      ...opts,
      expires: this.now() + opts.timeoutS * 1000,
    };
    this.byToken.set(lock.token, lock);
    const set = this.byPath.get(p) ?? new Set<Lock>();
    set.add(lock);
    this.byPath.set(p, set);
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
    const l = this.byToken.get(token);
    if (!l) return false;
    this.remove(l);
    return true;
  }

  /** Drop every lock on `p` or beneath it (it was deleted or moved away). */
  dropBeneath(p: string): void {
    for (const l of this.beneath(p)) this.remove(l);
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
