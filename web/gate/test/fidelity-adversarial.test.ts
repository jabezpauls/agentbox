import { describe, expect, it } from "vitest";
import { hasOwnImportMap, rewriteCss, rewriteHtml } from "../src/fidelity.js";

const P = "/a/abcdefghijklmnopqrstuvwxyz";

/**
 * Pages built to make the rewriters slow. Each of these took time growing
 * with the square of the page before, so a few hundred KiB froze the gate;
 * a rewritten page is at most MAX_REWRITE (a few MiB), so 8 MiB bounds them.
 */
describe("adversarial pages", () => {
  const EIGHT_MIB = 8 * 1024 * 1024;
  const cases: Array<[string, () => void]> = [
    ["<script with no >", () => rewriteHtml("<script".repeat(EIGHT_MIB / 7), { prefix: P })],
    ["<script type= with no >", () => rewriteHtml("<script type=".repeat(EIGHT_MIB / 13), { prefix: P })],
    ["unclosed quotes in a tag", () => rewriteHtml(`<a x="${'a="'.repeat(EIGHT_MIB / 3)}`, { prefix: P })],
    ["a closed tag of unclosed-looking quotes", () => rewriteHtml(`<a ${'x"a="'.repeat(EIGHT_MIB / 6)}>`, { prefix: P })],
    ["<style> of url( with no )", () => rewriteHtml(`<style>${"url(".repeat(EIGHT_MIB / 4)}`, { prefix: P })],
    ["CSS of url( with no )", () => rewriteCss("url(".repeat(EIGHT_MIB / 4), P)],
    ["CSS of url( and spaces", () => rewriteCss(`url(${" ".repeat(EIGHT_MIB)}`, P)],
    ["CSS of url(\" with no close", () => rewriteCss('url("'.repeat(EIGHT_MIB / 5), P)],
    ['CSS of @import "', () => rewriteCss('@import "'.repeat(EIGHT_MIB / 9), P)],
    ["comments that never close", () => rewriteHtml("<!--".repeat(EIGHT_MIB / 4), { prefix: P })],
    ["end tags that never close", () => rewriteHtml("</a".repeat(EIGHT_MIB / 3), { prefix: P })],
    ["raw text that never closes", () => rewriteHtml("<script></script".repeat(EIGHT_MIB / 16), { prefix: P })],
    ["a srcset of commas", () => rewriteHtml(`<img srcset="${",".repeat(EIGHT_MIB)}">`, { prefix: P })],
    ["localhost, again and again", () => rewriteHtml("http://localhost:".repeat(EIGHT_MIB / 17), { prefix: P })],
  ];
  for (const [what, run] of cases) {
    it(`finish in well under a second: ${what}`, () => {
      const t0 = performance.now();
      run();
      expect(performance.now() - t0).toBeLessThan(1_000);
    });
  }

  it("still find an import map the page brings, and only one", () => {
    expect(hasOwnImportMap(`<head><SCRIPT id="m" TYPE='importmap'>{}</SCRIPT></head>`)).toBe(true);
    expect(hasOwnImportMap(`<script type=importmap>{}</script>`)).toBe(true);
    expect(hasOwnImportMap(`<head><scripts type="importmap"></head>`)).toBe(false);
    expect(hasOwnImportMap(`<head><script type="module">{}</script></head>`)).toBe(false);
    expect(rewriteHtml(`<head><script type="importmap">{}</script></head>`, { prefix: P }).hint).toBe("root-absolute");
  });

  it("rewrite quoted and bare url()s, and leave one holding a parenthesis", () => {
    expect(rewriteCss(`a{b:url( /x.png )} c{d:url("/y (1).png")} e{f:url('/z.png')}`, P)).toBe(
      `a{b:url(${P}/x.png)} c{d:url("/y (1).png")} e{f:url('${P}/z.png')}`,
    );
  });
});
