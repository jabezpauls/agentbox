import type { SurfaceId } from "./routes.ts";
import { SURFACES } from "./surfaces.ts";

/**
 * The shell's keyboard: moving between surfaces, the palette, the dock and
 * the keymap. Chosen so that none of it collides with the browser or with VS
 * Code's default keymap, because the same keys must work inside the editor:
 *
 *  - ⌃⌥ (Ctrl+Alt) + a key works everywhere — surfaces, terminals and the
 *    editor frame. VS Code binds none of ⌃⌥1–6, ⌃⌥K, ⌃⌥D, ⌃⌥, or ⌃⌥/ on
 *    Linux, Windows or macOS (checked against code-server's own keymap), and
 *    browsers reserve none of them.
 *  - ⌘K / Ctrl+K opens the palette too, except in the editor, where it is VS
 *    Code's chord prefix.
 *  - `g` then a letter, and `?`, work wherever keys are not being typed into
 *    something.
 *
 * On Windows, Ctrl+Alt is AltGr, which types characters on many layouts
 * (AltGr+7 is `{` on a German keyboard). Those arrive with the character as
 * their `key`, so a chord only counts when its `key` is the key itself, and
 * typing is never taken away.
 */

export type ShellAction =
  | { kind: "palette" }
  | { kind: "go"; surface: SurfaceId }
  | { kind: "dock" }
  | { kind: "keymap" };

/** The subset of a KeyboardEvent the shell reads, so tests can pass plain objects. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  getModifierState?(key: string): boolean;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad/i.test(platform);
}

/** The key a physical key code stands for, unmodified: "Digit1" → "1", "KeyK" → "k". */
function physical(code: string): string | null {
  let m = /^Digit(\d)$/.exec(code);
  if (m) return m[1]!;
  m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1]!.toLowerCase();
  if (code === "Comma") return ",";
  if (code === "Slash") return "/";
  return null;
}

const CHORD: Record<string, ShellAction> = {
  k: { kind: "palette" },
  d: { kind: "dock" },
  "/": { kind: "keymap" },
  ...Object.fromEntries(SURFACES.map((s) => [s.key, { kind: "go", surface: s.id } as ShellAction])),
};

/** A ⌃⌥ chord, or null. */
export function chordAction(e: KeyLike, mac: boolean): ShellAction | null {
  if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey) return null;
  const key = physical(e.code);
  if (key === null) return null;
  // Everywhere but a Mac, the key must be the key: anything else is AltGr
  // producing a character.
  if (!mac && (e.getModifierState?.("AltGraph") || e.key.toLowerCase() !== key)) return null;
  return CHORD[key] ?? null;
}

/** ⌘K on a Mac, Ctrl+K elsewhere (and either, leniently). */
export function isPaletteKey(e: KeyLike): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K");
}

const LETTERS: Record<string, SurfaceId> = Object.fromEntries(SURFACES.map((s) => [s.letter, s.id]));

/**
 * `g` then a letter. The `g` arms it for a moment; the next key resolves it,
 * whatever it is, so a stray `g` never swallows more than one keystroke.
 */
export class GoSequence {
  private armedAt: number | null = null;

  constructor(
    private readonly timeoutMs = 1500,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get armed(): boolean {
    return this.armedAt !== null && this.now() - this.armedAt <= this.timeoutMs;
  }

  /** Feed one bare keystroke. `consumed` says whether the shell took it. */
  feed(key: string): { consumed: boolean; surface?: SurfaceId } {
    if (this.armed) {
      this.armedAt = null;
      const surface = LETTERS[key.toLowerCase()];
      return surface ? { consumed: true, surface } : { consumed: false };
    }
    this.armedAt = null;
    if (key === "g") {
      this.armedAt = this.now();
      return { consumed: true };
    }
    return { consumed: false };
  }

  reset(): void {
    this.armedAt = null;
  }
}

/** A keystroke with no modifier but Shift: something a sequence may read. */
export function isBareKey(e: KeyLike): boolean {
  return !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1;
}

/** How a chord reads to a person on this platform: "⌃⌥1" or "Ctrl+Alt+1". */
export function chordLabel(key: string, mac = isMacPlatform()): string {
  const k = key.toUpperCase();
  return mac ? `⌃⌥${k}` : `Ctrl+Alt+${k}`;
}

/** The palette's own key, as it reads on this platform. */
export function paletteLabel(mac = isMacPlatform()): string {
  return mac ? "⌘K" : "Ctrl+K";
}
