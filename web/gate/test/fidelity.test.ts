import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { injection, isRootAbsolute, rewriteCss, rewriteHtml, rewriteSrcset, shimSource } from "../src/fidelity.js";

const P = "/a/abcdefghijklmnopqrstuvwxyz";

describe("what counts as a path from the root of the box", () => {
  it("is a single-slash path that is not already the app's", () => {
    for (const v of ["/", "/src/main.tsx", "/@vite/client", "/vite.svg?x=1"]) expect(isRootAbsolute(v, P), v).toBe(true);
    for (const v of ["//cdn.example/x.js", "/\\evil", "x.js", "./x.js", "https://x/y", `${P}/x`, P, `${P}?q`, "", "#top"]) {
      expect(isRootAbsolute(v, P), v).toBe(false);
    }
  });
});

describe("the HTML rewrite", () => {
  const vite = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <script type="module">import { injectIntoGlobalHook } from "/@react-refresh";
injectIntoGlobalHook(window);</script>
    <script type="module" src="/@vite/client"></script>
    <title>Vite + React + TS</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

  it("puts the shim and the import map first in the head, before any script", () => {
    const { html } = rewriteHtml(vite, { prefix: P });
    const head = html.indexOf("<head>") + "<head>".length;
    expect(html.slice(head).startsWith(injection(P, true))).toBe(true);
    expect(html.indexOf("importmap")).toBeLessThan(html.indexOf('type="module"'));
    expect(html).toContain(`{"imports":{"/":"${P}/","${P}/":"${P}/"}}`);
    expect(html).toContain(`<script src="${P}/__agentbox/shim.js"></script>`);
  });

  it("prefixes root-absolute attribute values and asks for credentials on module scripts", () => {
    const { html, hint } = rewriteHtml(vite, { prefix: P });
    expect(html).toContain(`href="${P}/vite.svg"`);
    expect(html).toContain(`<script type="module" src="${P}/@vite/client" crossorigin="use-credentials"></script>`);
    expect(html).toContain(`<script type="module" src="${P}/src/main.tsx" crossorigin="use-credentials"></script>`);
    // An inline module's imports follow its element's credentials mode; its text is untouched.
    expect(html).toContain(`<script type="module" crossorigin="use-credentials">import { injectIntoGlobalHook } from "/@react-refresh";`);
    expect(hint).toBeNull();
  });

  it("leaves what is already the app's, another host's or relative alone", () => {
    const src = `<head></head><img src="${P}/a.png"><img src="//cdn.x/b.png"><img src="c.png"><a href="https://x.example/">x</a><a href="#top">t</a>`;
    const { html } = rewriteHtml(src, { prefix: P });
    expect(html).toContain(`<img src="${P}/a.png">`);
    expect(html).toContain(`<img src="//cdn.x/b.png">`);
    expect(html).toContain(`<img src="c.png">`);
    expect(html).toContain(`<a href="https://x.example/">`);
  });

  it("reaches every URL attribute, srcset and inline styles", () => {
    const src = `<head></head><form action="/login"><button formaction="/save">s</button></form><video poster="/p.png"><source srcset="/a.png 1x, /b.png 2x"></video><div style="background:url(/bg.png)"></div><base href="/">`;
    const { html } = rewriteHtml(src, { prefix: P });
    expect(html).toContain(`action="${P}/login"`);
    expect(html).toContain(`formaction="${P}/save"`);
    expect(html).toContain(`poster="${P}/p.png"`);
    expect(html).toContain(`srcset="${P}/a.png 1x, ${P}/b.png 2x"`);
    expect(html).toContain(`style="background:url(${P}/bg.png)"`);
    expect(html).toContain(`<base href="${P}/">`);
  });

  it("gives a build's crossorigin assets credentials too", () => {
    const src = `<head><script type="module" crossorigin src="/assets/i.js"></script><link rel="stylesheet" crossorigin href="/assets/i.css"><link rel="modulepreload" href="/assets/v.js"></head>`;
    const { html } = rewriteHtml(src, { prefix: P });
    expect(html).toContain(`<script type="module" crossorigin="use-credentials" src="${P}/assets/i.js"></script>`);
    expect(html).toContain(`<link rel="stylesheet" crossorigin="use-credentials" href="${P}/assets/i.css">`);
    expect(html).toContain(`<link rel="modulepreload" href="${P}/assets/v.js" crossorigin="use-credentials">`);
  });

  it("does not look inside comments, scripts or style text for tags", () => {
    const src = `<head></head><!-- <img src="/c.png"> --><script>var s = '<img src="/s.png">';</script><style>.x{background:url(/bg.png)} /* <a href="/z"> */</style><textarea><a href="/t"></textarea>`;
    const { html } = rewriteHtml(src, { prefix: P });
    expect(html).toContain(`<!-- <img src="/c.png"> -->`);
    expect(html).toContain(`var s = '<img src="/s.png">';`);
    // Style text is CSS, and is rewritten as CSS.
    expect(html).toContain(`url(${P}/bg.png)`);
    expect(html).toContain(`<textarea><a href="/t"></textarea>`);
  });

  it("injects before the first element when the page has no head", () => {
    const { html } = rewriteHtml(`<p>hi</p><script type="module" src="/m.js"></script>`, { prefix: P });
    expect(html.startsWith(injection(P, true))).toBe(true);
  });

  it("keeps a page's own import map and says the page may not work", () => {
    const src = `<head><script type="importmap">{"imports":{"react":"/r.js"}}</script></head>`;
    const { html, hint } = rewriteHtml(src, { prefix: P });
    expect(html).not.toContain(`"/":"${P}/"`);
    expect(html).toContain(`${P}/__agentbox/shim.js`);
    expect(hint).toBe("root-absolute");
  });

  it("says so when the page names its own origin", () => {
    expect(rewriteHtml(`<head></head><script>fetch("http://localhost:5173/api")</script>`, { prefix: P }).hint).toBe("root-absolute");
  });

  it("copies what it does not understand through as written", () => {
    const odd = `<head></head><p>a < b and c > d</p><x-y data-a='1' b=2 c>t</x-y><img src=/u.png alt=x>`;
    const { html } = rewriteHtml(odd, { prefix: P });
    expect(html).toContain(`<p>a < b and c > d</p><x-y data-a='1' b=2 c>t</x-y>`);
    expect(html).toContain(`<img src="${P}/u.png" alt="x">`);
  });
});

describe("the CSS rewrite", () => {
  it("prefixes url() and @import paths from the root", () => {
    const css = `@import "/base.css"; a{background:url(/a.png)} b{background:url('/b.png')} c{background:url( "/c.png" )} d{background:url(d.png)} e{background:url(//cdn/e.png)} f{src:url(data:x)}`;
    const out = rewriteCss(css, P);
    expect(out).toContain(`@import "${P}/base.css"`);
    expect(out).toContain(`url(${P}/a.png)`);
    expect(out).toContain(`url('${P}/b.png')`);
    expect(out).toContain(`url("${P}/c.png")`);
    expect(out).toContain(`url(d.png)`);
    expect(out).toContain(`url(//cdn/e.png)`);
    expect(out).toContain(`url(data:x)`);
  });

  it("rewrites every candidate of a srcset", () => {
    expect(rewriteSrcset("/a.png 1x,/b.png 2x, c.png 3x", P)).toBe(`${P}/a.png 1x,${P}/b.png 2x, c.png 3x`);
  });
});

describe("the runtime shim", () => {
  it("is plain script that parses", () => {
    expect(() => new vm.Script(shimSource(P))).not.toThrow();
  });

  it("prefixes what a page builds at runtime, and nothing else", () => {
    // A tiny stand-in for a window: enough of the DOM for the shim's fix() to run.
    const calls: Array<[string, unknown]> = [];
    const sandbox: Record<string, unknown> = {
      location: { host: "box.example", href: `https://box.example${P}/`, protocol: "https:" },
      URL,
      Map,
      Array,
      Object,
      JSON,
      Date,
      Number,
      String,
      Request: class {
        constructor(
          public url: string,
          public init?: unknown,
        ) {}
      },
      fetch: (input: unknown, init: unknown) => {
        calls.push([String(input), init]);
        return Promise.resolve();
      },
      document: {},
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(shimSource(P), sandbox);
    const f = sandbox.fetch as (u: unknown, i?: unknown) => void;
    f("/api/x");
    f(`${P}/api/y`);
    f("https://box.example/api/z");
    f("https://other.example/api");
    f("rel/path");
    expect(calls.map((c) => c[0])).toEqual([
      `${P}/api/x`,
      `${P}/api/y`,
      `https://box.example${P}/api/z`,
      "https://other.example/api",
      "rel/path",
    ]);
    // The app's own requests carry its grant; another site's are left alone.
    expect(calls[0]?.[1]).toEqual({ credentials: "include" });
    expect(calls[3]?.[1]).toBeUndefined();
  });
});
