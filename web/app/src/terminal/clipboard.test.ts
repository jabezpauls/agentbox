import { describe, expect, it } from "vitest";
import { clipboardKey, parseOsc52 } from "./clipboard.ts";

const key = (k: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}) => ({
  key: k,
  code: `Key${k.toUpperCase()}`,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("parseOsc52", () => {
  it("decodes a copy, UTF-8 included", () => {
    expect(parseOsc52(`c;${btoa("hello")}`)).toEqual({ write: "hello" });
    const utf8 = btoa(String.fromCharCode(...new TextEncoder().encode("héllo ✓")));
    expect(parseOsc52(`;${utf8}`)).toEqual({ write: "héllo ✓" });
  });

  it("recognises a request to read the clipboard, so it can be refused", () => {
    expect(parseOsc52("c;?")).toBe("read");
  });

  it("ignores what is not a copy", () => {
    expect(parseOsc52("nonsense")).toBeNull();
    expect(parseOsc52("c;!!not base64!!")).toBeNull();
    expect(parseOsc52(`c;${"A".repeat(2 * 1024 * 1024)}`)).toBeNull();
  });
});

describe("clipboardKey", () => {
  it("takes Ctrl+Shift+C and Ctrl+Shift+V, but leaves Ctrl+C to the shell", () => {
    expect(clipboardKey(key("C", { ctrlKey: true, shiftKey: true }), false, false)).toBe("copy");
    expect(clipboardKey(key("V", { ctrlKey: true, shiftKey: true }), false, false)).toBe("paste");
    expect(clipboardKey(key("c", { ctrlKey: true }), false, true)).toBeNull();
    expect(clipboardKey(key("v", { ctrlKey: true }), false, true)).toBeNull();
  });

  it("on a Mac, takes ⌘C only while text is selected, and ⌘V", () => {
    expect(clipboardKey(key("c", { metaKey: true }), true, true)).toBe("copy");
    expect(clipboardKey(key("c", { metaKey: true }), true, false)).toBeNull();
    expect(clipboardKey(key("v", { metaKey: true }), true, false)).toBe("paste");
    expect(clipboardKey(key("c", { metaKey: true }), false, true)).toBeNull();
  });
});
