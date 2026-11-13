import { describe, it, expect } from "vitest";
import { encodePathParam } from "@workbench/shared";
import {
  decodeComponent,
  decodeName,
  displayName,
  encodeName,
  encodeSegment,
  hasEscapes,
  NameError,
  parseQuery,
} from "../src/files/names.js";

const bytes = (...b: number[]) => Uint8Array.from(b);

describe("filename bytes and text", () => {
  it("passes valid UTF-8 through untouched", () => {
    for (const s of ["plain.txt", "naïve café", "日本語", "emoji 🚀", "line\nbreak", "\u{10080}"]) {
      expect(decodeName(Buffer.from(s, "utf8"))).toBe(s);
      expect(hasEscapes(s)).toBe(false);
      expect(encodeName(s).toString("utf8")).toBe(s);
    }
  });

  it("escapes each stray byte as a lone surrogate and round-trips it exactly", () => {
    const cases = [
      bytes(0x61, 0xff, 0x62), // an invalid byte
      bytes(0xc3), // a truncated sequence
      bytes(0xc0, 0xaf), // an overlong slash
      bytes(0xed, 0xa0, 0x80), // an encoded surrogate
      bytes(0xf4, 0x90, 0x80, 0x80), // above U+10FFFF
      bytes(0xe2, 0x9c, 0x93, 0x80, 0xe2, 0x9c, 0x93), // valid, stray, valid
    ];
    for (const b of cases) {
      const s = decodeName(b);
      expect(hasEscapes(s)).toBe(true);
      expect([...encodeName(s)]).toEqual([...b]);
    }
    expect(decodeName(bytes(0x61, 0xff, 0x62))).toBe("a\udcffb");
  });

  it("refuses a lone surrogate that no byte could have produced", () => {
    expect(() => encodeName("a\ud800b")).toThrow(NameError);
  });

  it("shows escaped bytes as the replacement character", () => {
    expect(displayName("a\udcffb")).toBe("a�b");
    expect(displayName("\u{10080}")).toBe("\u{10080}");
  });

  it("parses a query byte-exactly and keeps repeated keys", () => {
    const q = parseQuery("/api/files/zip?path=%FF%61&path=a+b&path=%E2%9C%93&flag&empty=");
    expect(q.get("path")).toEqual(["\udcffa", "a b", "✓"]);
    expect(q.get("flag")).toEqual([""]);
    expect(q.get("empty")).toEqual([""]);
    expect(parseQuery("/no-query").size).toBe(0);
  });

  it("round-trips any name through the client's encoder and the server's parser", () => {
    for (const name of ["/w/a\udcffb", "/w/sp ace+plus&amp=eq", "/w/line\nbreak", "/w/🚀/%41"]) {
      const q = parseQuery(`/x?path=${encodePathParam(name)}`);
      expect(q.get("path")).toEqual([name]);
    }
  });

  it("encodes URL segments strictly, so no guard ever sees a raw ; or backslash", () => {
    expect(encodeSegment("a;b\\c d")).toBe("a%3Bb%5Cc%20d");
    expect(encodeSegment("a\udcffb")).toBe("a%FFb");
    expect(decodeComponent("a%3Bb%5Cc%20d", false)).toBe("a;b\\c d");
    expect(decodeComponent("a+b", false)).toBe("a+b");
  });
});
