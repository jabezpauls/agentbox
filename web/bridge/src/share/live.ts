/**
 * The exchanges currently open through each share token — proxied HTTP
 * streams and websockets — so revoking or expiring a share cuts them at once
 * rather than leaving an already-connected viewer streaming indefinitely.
 */
export class LiveShares {
  private open = new Map<string, Set<() => void>>();

  /** Register a closer for `token`; returns its unregister. */
  track(token: string, close: () => void): () => void {
    let set = this.open.get(token);
    if (!set) {
      set = new Set();
      this.open.set(token, set);
    }
    const owned = set;
    owned.add(close);
    return () => {
      owned.delete(close);
      if (owned.size === 0 && this.open.get(token) === owned) this.open.delete(token);
    };
  }

  /** Close everything open through `token`. */
  closeAll(token: string): void {
    const set = this.open.get(token);
    if (!set) return;
    this.open.delete(token);
    for (const close of [...set]) {
      try {
        close();
      } catch {
        // already torn down
      }
    }
  }

  /** Tokens with at least one open exchange. */
  tokens(): string[] {
    return [...this.open.keys()];
  }
}
