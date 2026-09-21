import type { ActionId } from "./actions.ts";

export interface PrefixResult {
  /** Whether the key was absorbed by the prefix layer (swallow it from xterm). */
  consumed: boolean;
  /** The action the armed prefix resolved to, if any. */
  action?: ActionId;
  /** Bytes to send verbatim to the terminal (prefix pressed twice). */
  passthrough?: string;
}

/**
 * The ctrl+b prefix model from the herdr TUI. `ctrl+b` arms the machine for one
 * key; that key is then resolved against the bindings. Pressing the prefix
 * twice sends the literal control byte through to the terminal. An armed prefix
 * expires after `timeoutMs` so a forgotten prefix does not swallow a later key.
 */
export class PrefixMachine {
  private armedAt: number | null = null;

  constructor(
    private readonly prefix: string = "ctrl+b",
    private readonly bindings: Record<string, ActionId> = {},
    private readonly timeoutMs: number = 3000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True while a prefix is armed and has not yet timed out. */
  get armed(): boolean {
    if (this.armedAt === null) return false;
    if (this.now() - this.armedAt > this.timeoutMs) {
      this.armedAt = null;
      return false;
    }
    return true;
  }

  /** The control byte a "ctrl+<letter>" prefix stands for, e.g. ctrl+b -> \x02. */
  private literal(): string {
    const m = /^ctrl\+([a-z])$/.exec(this.prefix);
    return m ? String.fromCharCode(m[1]!.charCodeAt(0) - 96) : "";
  }

  feed(combo: string): PrefixResult {
    if (!this.armed) {
      if (combo === this.prefix) {
        this.armedAt = this.now();
        return { consumed: true };
      }
      return { consumed: false };
    }

    // A key follows an armed prefix: it resolves the prefix either way.
    this.armedAt = null;
    if (combo === this.prefix) return { consumed: true, passthrough: this.literal() };
    const action = this.bindings[combo];
    if (action) return { consumed: true, action };
    return { consumed: true };
  }
}
