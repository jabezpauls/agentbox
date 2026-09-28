import { describe, expect, it } from "vitest";
import { chordAction, GoSequence, isPaletteKey, type KeyLike } from "./keys.ts";

function key(partial: Partial<KeyLike> & { key: string; code: string }): KeyLike {
  return { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...partial };
}

const ctrlAlt = (k: string, code: string, extra: Partial<KeyLike> = {}) =>
  key({ key: k, code, ctrlKey: true, altKey: true, ...extra });

describe("chordAction", () => {
  it("maps ⌃⌥ + a digit to each surface", () => {
    expect(chordAction(ctrlAlt("1", "Digit1"), false)).toEqual({ kind: "go", surface: "home" });
    expect(chordAction(ctrlAlt("2", "Digit2"), false)).toEqual({ kind: "go", surface: "workbench" });
    expect(chordAction(ctrlAlt("3", "Digit3"), false)).toEqual({ kind: "go", surface: "editor" });
    expect(chordAction(ctrlAlt("4", "Digit4"), false)).toEqual({ kind: "go", surface: "files" });
    expect(chordAction(ctrlAlt("5", "Digit5"), false)).toEqual({ kind: "go", surface: "apps" });
    expect(chordAction(ctrlAlt("6", "Digit6"), false)).toEqual({ kind: "go", surface: "system" });
    expect(chordAction(ctrlAlt(",", "Comma"), false)).toEqual({ kind: "go", surface: "settings" });
  });

  it("maps the palette, the dock and the keymap", () => {
    expect(chordAction(ctrlAlt("k", "KeyK"), false)).toEqual({ kind: "palette" });
    expect(chordAction(ctrlAlt("d", "KeyD"), false)).toEqual({ kind: "dock" });
    expect(chordAction(ctrlAlt("/", "Slash"), false)).toEqual({ kind: "keymap" });
  });

  it("leaves AltGr typing alone", () => {
    // German Windows: Ctrl+Alt+7 is AltGr+7, which types "{".
    expect(chordAction(ctrlAlt("{", "Digit7"), false)).toBeNull();
    expect(chordAction(ctrlAlt("k", "KeyK", { getModifierState: (m) => m === "AltGraph" }), false)).toBeNull();
  });

  it("reads the physical key on a Mac, where ⌥ changes the character", () => {
    expect(chordAction(ctrlAlt("¡", "Digit1"), true)).toEqual({ kind: "go", surface: "home" });
    expect(chordAction(ctrlAlt("˚", "KeyK"), true)).toEqual({ kind: "palette" });
  });

  it("wants exactly ⌃⌥, nothing more and nothing less", () => {
    expect(chordAction(key({ key: "1", code: "Digit1", ctrlKey: true }), false)).toBeNull();
    expect(chordAction(ctrlAlt("1", "Digit1", { shiftKey: true }), false)).toBeNull();
    expect(chordAction(ctrlAlt("1", "Digit1", { metaKey: true }), false)).toBeNull();
    expect(chordAction(ctrlAlt("x", "KeyX"), false)).toBeNull();
  });
});

describe("isPaletteKey", () => {
  it("is ⌘K or Ctrl+K", () => {
    expect(isPaletteKey(key({ key: "k", code: "KeyK", metaKey: true }))).toBe(true);
    expect(isPaletteKey(key({ key: "k", code: "KeyK", ctrlKey: true }))).toBe(true);
    expect(isPaletteKey(key({ key: "k", code: "KeyK" }))).toBe(false);
    expect(isPaletteKey(key({ key: "k", code: "KeyK", ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("leaves Ctrl+K to a field or a terminal being typed into", () => {
    expect(isPaletteKey(key({ key: "k", code: "KeyK", ctrlKey: true }), true)).toBe(false);
    expect(isPaletteKey(key({ key: "k", code: "KeyK", metaKey: true }), true)).toBe(true);
  });
});

describe("GoSequence", () => {
  it("goes to a surface on g then its letter", () => {
    const seq = new GoSequence();
    expect(seq.feed("g")).toEqual({ consumed: true });
    expect(seq.feed("f")).toEqual({ consumed: true, surface: "files" });
  });

  it("lets an unrelated key through and disarms", () => {
    const seq = new GoSequence();
    seq.feed("g");
    expect(seq.feed("z")).toEqual({ consumed: false });
    expect(seq.feed("f")).toEqual({ consumed: false });
  });

  it("expires", () => {
    let t = 0;
    const seq = new GoSequence(1000, () => t);
    seq.feed("g");
    t = 1500;
    expect(seq.feed("h")).toEqual({ consumed: false });
  });

  it("ignores letters on their own", () => {
    const seq = new GoSequence();
    expect(seq.feed("h")).toEqual({ consumed: false });
  });
});
