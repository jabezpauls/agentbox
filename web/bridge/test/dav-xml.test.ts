import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { parseXml, XML_LIMITS, XmlError, serialize } from "../src/files/dav/xml.js";
import { filesFixture, type FilesFixture } from "./helpers/files.js";

/** Time a parse; return whether it threw an XmlError, and how long it took. */
function timed(src: string): { ms: number; refused: boolean } {
  const t0 = performance.now();
  let refused = false;
  try {
    parseXml(src);
  } catch (err) {
    if (!(err instanceof XmlError)) throw err;
    refused = true;
  }
  return { ms: performance.now() - t0, refused };
}

describe("the WebDAV XML parser", () => {
  it("resolves namespaces through enclosing elements", () => {
    const doc = parseXml('<a:x xmlns:a="urn:a" xmlns="urn:d"><y><a:z xmlns:a="urn:b"/><a:w/></y></a:x>');
    expect(doc).toMatchObject({ ns: "urn:a", local: "x" });
    const y = doc.children[0]!;
    expect(y).toMatchObject({ ns: "urn:d", local: "y" });
    expect(y.children.map((c) => c.ns)).toEqual(["urn:b", "urn:a"]);
    expect(serialize(y.children[0]!)).toBe('<z xmlns="urn:b"></z>');
  });

  it("stays fast on a body of many declarations and many elements", () => {
    // The reviewer's shape: a megabyte of declarations and elements, which
    // used to copy every declaration into every element.
    const decls = Array.from({ length: 60 }, (_, n) => `xmlns:p${n}="urn:${n}"`).join(" ");
    const kids = "<p1:x/>".repeat(9000);
    const big = `<root ${decls}>${kids}</root>`;
    const r = timed(big);
    expect(r.refused).toBe(false);
    expect(r.ms).toBeLessThan(250);

    const huge = `<root>${`<a xmlns:q="urn:q"/>`.repeat(50_000)}</root>`;
    expect(huge.length).toBeGreaterThan(1_000_000);
    const h = timed(huge);
    expect(h.refused).toBe(true);
    expect(h.ms).toBeLessThan(250);
  });

  it("caps elements, attributes and depth", () => {
    expect(timed(`<r>${"<a/>".repeat(XML_LIMITS.elements)}</r>`).refused).toBe(true);
    expect(timed(`<r ${Array.from({ length: XML_LIMITS.attributes + 1 }, (_, n) => `a${n}="1"`).join(" ")}/>`).refused).toBe(true);
    const deep = "<a>".repeat(XML_LIMITS.depth + 1) + "</a>".repeat(XML_LIMITS.depth + 1);
    expect(timed(deep).refused).toBe(true);
    const ok = "<a>".repeat(XML_LIMITS.depth) + "</a>".repeat(XML_LIMITS.depth);
    expect(timed(ok).refused).toBe(false);
  });

  it("refuses character references that are not XML characters", () => {
    for (const ref of ["&#99999999;", "&#x110000;", "&#0;", "&#xD800;", "&#xFFFE;"]) {
      expect(() => parseXml(`<a>${ref}</a>`), ref).toThrow(XmlError);
    }
    expect(parseXml("<a>&#x1F680;&#65;&amp;</a>").text).toBe("🚀A&");
  });
});

describe("hostile bodies over HTTP", () => {
  let f: FilesFixture;
  let base: string;
  beforeAll(async () => {
    f = await filesFixture();
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(f.app.server.address() as AddressInfo).port}/api/dav/`;
  });
  afterAll(async () => {
    await f.close();
  });

  const propfind = (body: string) =>
    fetch(base, { method: "PROPFIND", headers: { depth: "0", "content-type": "application/xml" }, body });

  it("answers 400, not 500, for a character reference out of range", async () => {
    const res = await propfind('<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:x>&#99999999;</D:x></D:prop></D:propfind>');
    expect(res.status).toBe(400);
  });

  it("refuses a megabyte body before parsing it", async () => {
    const t0 = performance.now();
    const res = await propfind(`<D:propfind xmlns:D="DAV:"><D:prop>${"<D:x/>".repeat(200_000)}</D:prop></D:propfind>`);
    expect(res.status).toBe(413);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("refuses a body with too many elements quickly", async () => {
    const t0 = performance.now();
    const res = await propfind(`<D:propfind xmlns:D="DAV:"><D:prop>${"<D:x/>".repeat(20_000)}</D:prop></D:propfind>`);
    expect(res.status).toBe(400);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
