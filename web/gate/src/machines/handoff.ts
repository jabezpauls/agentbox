import { digest, newSecret } from "../auth.js";

/**
 * The handoff from the box's origin to the machines origin. The main origin's
 * `GET /_gate/machines/handoff`, with a main session, issues a nonce bound to
 * that session and sends the tab to the machines origin's sign-in with it;
 * the sign-in takes it back, once, with the machines passphrase. The nonce
 * alone opens nothing, so its appearing in a URL does not matter; held in
 * memory only, as a digest, for 60 seconds.
 */

export const HANDOFF_MS = 60_000;
const MAX_PENDING = 64;

interface Pending {
  mainSessionId: string;
  expiresAt: number;
}

export class Handoffs {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.pending.size;
  }

  issue(mainSessionId: string): string {
    this.sweep();
    // Oldest first, in insertion order: a page that asks in a loop pushes out
    // only its own earlier nonces.
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value as string;
      this.pending.delete(oldest);
    }
    const nonce = newSecret();
    this.pending.set(digest(nonce), { mainSessionId, expiresAt: this.now() + HANDOFF_MS });
    return nonce;
  }

  /** Whether `nonce` could still be taken; changes nothing (the sign-in page's GET). */
  peek(nonce: string): boolean {
    const p = this.pending.get(digest(nonce));
    return p !== undefined && this.now() < p.expiresAt;
  }

  /** The main session `nonce` was issued for, once; `null` if it is unknown, used or expired. */
  take(nonce: string): string | null {
    const key = digest(nonce);
    const p = this.pending.get(key);
    if (!p) return null;
    this.pending.delete(key);
    return this.now() < p.expiresAt ? p.mainSessionId : null;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, p] of this.pending) if (t >= p.expiresAt) this.pending.delete(k);
  }
}
