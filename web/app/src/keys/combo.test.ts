import { describe, expect, it } from "vitest";
import { comboFromEvent } from "./combo.ts";

// A minimal KeyboardEvent-like shape; comboFromEvent only reads these fields.
function ev(partial: Partial<KeyboardEvent>): KeyboardEvent {
  return { key: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...partial } as KeyboardEvent;
}

describe("comboFromEvent", () => {
  it("prefixes control-modified letters", () => {
    expect(comboFromEvent(ev({ key: "b", ctrlKey: true }))).toBe("ctrl+b");
  });

  it("keeps shift only for letters and lowercases the letter", () => {
    expect(comboFromEvent(ev({ key: "N", shiftKey: true }))).toBe("shift+n");
  });

  it("names punctuation without a shift modifier", () => {
    expect(comboFromEvent(ev({ key: "-" }))).toBe("minus");
    // '?' is typed with shift on a US keyboard but the glyph already says so.
    expect(comboFromEvent(ev({ key: "?", shiftKey: true }))).toBe("?");
  });

  it("names special keys", () => {
    expect(comboFromEvent(ev({ key: "Escape" }))).toBe("esc");
    expect(comboFromEvent(ev({ key: "Enter" }))).toBe("enter");
  });

  it("passes digits through", () => {
    expect(comboFromEvent(ev({ key: "1" }))).toBe("1");
  });

  it("orders modifiers ctrl+alt+shift+meta", () => {
    expect(comboFromEvent(ev({ key: "b", ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+b");
  });
});
