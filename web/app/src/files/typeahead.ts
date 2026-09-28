/**
 * Type to jump in the file list — letters typed together find the next name
 * starting with them — sharing the keyboard with the shell's own bare keys:
 * `?` opens the keymap sheet and `g` then a letter moves between surfaces
 * (see shell/keys.ts). Those must still work with the list focused, which is
 * most of the time on Files.
 *
 * - `?` is never a jump.
 * - A `g` that starts a run does both: it jumps, and is left to the shell,
 *   which arms its sequence. The next key, if it names a surface, is the
 *   shell's; otherwise the run goes on ("gi" finds "git"), and the list
 *   disarms the shell.
 * - A `g` inside a run is only a letter ("log").
 */
export interface TypeAhead {
  text: string;
  at: number;
}

export type TypeAheadStep =
  /** Not the list's: leave the key alone. */
  | { kind: "pass" }
  /** Jump to the next name starting with `query`; `share` leaves the key to the shell as well. */
  | { kind: "jump"; query: string; fresh: boolean; share: boolean };

export const RUN_MS = 700;

export function stepTypeAhead(t: TypeAhead, key: string, now: number, shellTakes: (key: string) => boolean): TypeAheadStep {
  if (key === "?" || shellTakes(key)) {
    t.text = "";
    return { kind: "pass" };
  }
  const continuing = t.text !== "" && now - t.at < RUN_MS;
  t.text = continuing ? t.text + key.toLowerCase() : key.toLowerCase();
  t.at = now;
  return { kind: "jump", query: t.text, fresh: !continuing, share: !continuing && key === "g" };
}
