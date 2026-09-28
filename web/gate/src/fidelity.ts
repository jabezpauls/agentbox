/**
 * Path fidelity: an app built to run at `/` still works under `/a/<id>/`.
 *
 * A dev server started plainly (`npm run dev`) writes `/src/main.tsx`,
 * `/@vite/client` and `/vite.svg` into its pages: paths from the root of the
 * box, which is the app shell, not the app. The gate fixes what it can reach
 * on the way through, for HTML and CSS only (everything else streams
 * untouched):
 *
 * 1. root-absolute `src`, `href`, `action`, `formaction`, `poster` and
 *    `srcset` values in the HTML get the app's prefix;
 * 2. module scripts and module preloads — and anything that already asked for
 *    CORS — get `crossorigin="use-credentials"`, so the whole module graph
 *    carries the app's grant from the page's opaque origin;
 * 3. an import map sends root-absolute module specifiers (`import
 *    "/@vite/client"`) under the prefix;
 * 4. a small runtime shim, the first script in the page, does the same for
 *    what script builds at runtime, and gives the page in-memory storage where
 *    its opaque origin would make `localStorage` or `document.cookie` throw;
 * 5. `url(/…)` and `@import "/…"` in CSS get the prefix.
 *
 * Where a page still names somewhere the layer cannot reach — it brings its
 * own import map, or it has its own absolute origin written in — the response
 * says so (`X-Agentbox-Hint: root-absolute`) and the Preview panel shows how to
 * start the app with its base path set instead.
 */

/** The response header the Preview panel reads from its probe. */
export const HINT_HEADER = "x-agentbox-hint";
export const HINT_ROOT_ABSOLUTE = "root-absolute";

/** Where the gate serves an app's own helpers, inside the app's namespace. */
export const RESERVED = "/__agentbox";

const URL_ATTRS = new Set(["src", "href", "action", "formaction", "poster"]);
/** Elements whose content is text up to their end tag, never markup. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"]);
/** An origin of the app's own, written into its page: a place the layer cannot move. */
const LOCAL_ORIGIN = /\b(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?\b/i;

/** True when `value` is a path from the root of the box (not `//host`) that is not already this app's. */
export function isRootAbsolute(value: string, prefix: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return false;
  return !(value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`) || value.startsWith(`${prefix}#`));
}

export function prefixed(value: string, prefix: string): string {
  return isRootAbsolute(value, prefix) ? `${prefix}${value}` : value;
}

/** A `srcset`: comma-separated candidates, each a URL and an optional descriptor. */
export function rewriteSrcset(value: string, prefix: string): string {
  return value
    .split(",")
    .map((candidate) => {
      const m = /^(\s*)(\S+)(.*)$/s.exec(candidate);
      if (!m) return candidate;
      const [, lead, url, rest] = m as unknown as [string, string, string, string];
      return `${lead}${prefixed(url, prefix)}${rest}`;
    })
    .join(",");
}

/** `url(/…)` and `@import "/…"` in a stylesheet. */
export function rewriteCss(css: string, prefix: string): string {
  return css
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, quote: string, url: string) => {
      const t = url.trim();
      return isRootAbsolute(t, prefix) ? `url(${quote}${prefix}${t}${quote})` : whole;
    })
    .replace(/@import\s+(['"])([^'"]*)\1/gi, (whole, quote: string, url: string) =>
      isRootAbsolute(url, prefix) ? `@import ${quote}${prefix}${url}${quote}` : whole,
    );
}

interface Attr {
  name: string;
  /** The raw value, as written (entities and all), without its quotes. */
  value: string | null;
  quote: string;
}

/** Parse a start tag's attributes from the text between its name and its `>`. */
function parseAttrs(text: string): Attr[] {
  const attrs: Attr[] = [];
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [, name, dq, sq, uq] = m as unknown as [string, string, string | undefined, string | undefined, string | undefined];
    if (dq !== undefined) attrs.push({ name, value: dq, quote: '"' });
    else if (sq !== undefined) attrs.push({ name, value: sq, quote: "'" });
    else if (uq !== undefined) attrs.push({ name, value: uq, quote: '"' });
    else attrs.push({ name, value: null, quote: "" });
  }
  return attrs;
}

function renderAttrs(attrs: Attr[]): string {
  return attrs
    .map((a) => (a.value === null ? ` ${a.name}` : ` ${a.name}=${a.quote}${a.value.replace(new RegExp(a.quote, "g"), a.quote === '"' ? "&quot;" : "&#39;")}${a.quote}`))
    .join("");
}

function attr(attrs: Attr[], name: string): Attr | undefined {
  return attrs.find((a) => a.name.toLowerCase() === name);
}

export interface RewriteResult {
  html: string;
  /** Why the page may still not work under a prefix, if it may not. */
  hint: string | null;
}

export interface RewriteOptions {
  /** `/a/<id>`, without the trailing slash. */
  prefix: string;
}

/** The import map and shim the gate puts first in every page's head. */
export function injection(prefix: string, withImportMap: boolean): string {
  const shim = `<script src="${prefix}${RESERVED}/shim.js"></script>`;
  if (!withImportMap) return shim;
  const map = JSON.stringify({ imports: { "/": `${prefix}/`, [`${prefix}/`]: `${prefix}/` } });
  return `${shim}<script type="importmap">${map}</script>`;
}

/**
 * Rewrite one HTML document. A tag scanner rather than a parser: it copies the
 * document through as written, and changes only the attribute values it
 * means to, so anything it does not understand passes through unchanged.
 */
export function rewriteHtml(src: string, opts: RewriteOptions): RewriteResult {
  const { prefix } = opts;
  const ownImportMap = /<script\b[^>]*\btype\s*=\s*["']?importmap\b/i.test(src);
  const inject = injection(prefix, !ownImportMap);
  let injected = false;
  let out = "";
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, lt);
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      const stop = end === -1 ? src.length : end + 3;
      out += src.slice(lt, stop);
      i = stop;
      continue;
    }
    const next = src.charAt(lt + 1);
    if (next === "!" || next === "?" || next === "/") {
      const end = src.indexOf(">", lt);
      const stop = end === -1 ? src.length : end + 1;
      out += src.slice(lt, stop);
      i = stop;
      continue;
    }
    if (!/[A-Za-z]/.test(next)) {
      out += "<";
      i = lt + 1;
      continue;
    }
    // A start tag: its name, then attributes up to the first `>` outside quotes.
    const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(src.slice(lt + 1, lt + 64));
    const name = (nameMatch?.[0] ?? "").toLowerCase();
    let j = lt + 1 + (nameMatch?.[0].length ?? 0);
    let quote: string | null = null;
    for (; j < src.length; j++) {
      const c = src.charAt(j);
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
    }
    if (j >= src.length) {
      // An unterminated tag: leave the rest as it is.
      out += src.slice(lt);
      break;
    }
    let body = src.slice(lt + 1 + (nameMatch?.[0].length ?? 0), j);
    const selfClosing = body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1);
    const attrs = parseAttrs(body);
    let changed = false;

    for (const a of attrs) {
      const lower = a.name.toLowerCase();
      if (a.value === null) continue;
      if (URL_ATTRS.has(lower)) {
        const v = prefixed(a.value.trim(), prefix);
        if (v !== a.value.trim()) {
          a.value = v;
          changed = true;
        }
      } else if (lower === "srcset" || lower === "imagesrcset") {
        const v = rewriteSrcset(a.value, prefix);
        if (v !== a.value) {
          a.value = v;
          changed = true;
        }
      } else if (lower === "style" && /url\(|@import/i.test(a.value)) {
        const v = rewriteCss(a.value, prefix);
        if (v !== a.value) {
          a.value = v;
          changed = true;
        }
      }
    }
    // The module graph must carry the grant: from an opaque origin a module
    // script is a CORS request, which sends no cookie unless asked to.
    const type = attr(attrs, "type")?.value?.trim().toLowerCase();
    const rel = attr(attrs, "rel")?.value?.toLowerCase().split(/\s+/) ?? [];
    const cors = attr(attrs, "crossorigin");
    const wantsCredentials = (name === "script" && type === "module") || (name === "link" && rel.includes("modulepreload")) || cors !== undefined;
    if (wantsCredentials && cors?.value !== "use-credentials") {
      if (cors) {
        cors.value = "use-credentials";
        cors.quote = '"';
      } else {
        attrs.push({ name: "crossorigin", value: "use-credentials", quote: '"' });
      }
      changed = true;
    }
    const tagText = changed ? `<${src.slice(lt + 1, lt + 1 + (nameMatch?.[0].length ?? 0))}${renderAttrs(attrs)}${selfClosing ? " /" : ""}>` : src.slice(lt, j + 1);

    // What goes first: the shim, and the import map, before any script at all.
    if (!injected && (name === "head" || name === "html")) {
      out += tagText;
      if (name === "head") {
        out += inject;
        injected = true;
      }
      i = j + 1;
      continue;
    }
    if (!injected && name !== "html" && name !== "meta" && name !== "title" && name !== "base" && name !== "link") {
      // No <head> tag before the first element that could matter: the shim goes here.
      out += inject;
      injected = true;
    }
    out += tagText;
    i = j + 1;

    if (RAW_TEXT.has(name) && !selfClosing) {
      const close = new RegExp(`</${name}\\s*>`, "i");
      const rest = src.slice(i);
      const m = close.exec(rest);
      const content = m ? rest.slice(0, m.index) : rest;
      out += name === "style" ? rewriteCss(content, prefix) : content;
      if (m) out += m[0];
      i += m ? m.index + m[0].length : rest.length;
    }
  }
  if (!injected) out = inject + out;

  const hint = ownImportMap || LOCAL_ORIGIN.test(src) ? HINT_ROOT_ABSOLUTE : null;
  return { html: out, hint };
}

/**
 * The runtime shim, served at `/a/<id>/__agentbox/shim.js`. Plain ES2017 in
 * one function, every patch on its own so a browser lacking one API loses only
 * that. It never touches a URL that is relative, on another host, or already
 * the app's.
 */
export function shimSource(prefix: string): string {
  return `/* agentbox: this page is served under ${prefix}/ — see docs/workbench.md */
(function () {
  "use strict";
  var P = ${JSON.stringify(prefix)};
  function under(path) {
    return path === P || path.indexOf(P + "/") === 0 || path.indexOf(P + "?") === 0 || path.indexOf(P + "#") === 0;
  }
  function fix(input) {
    var s;
    if (typeof input === "string") s = input;
    else if (typeof URL !== "undefined" && input instanceof URL) s = input.href;
    else return input;
    if (s.charAt(0) === "/" && s.charAt(1) !== "/" && s.charAt(1) !== "\\\\") return under(s) ? s : P + s;
    if (!/^(https?|wss?):\\/\\//i.test(s)) return input;
    var url;
    try { url = new URL(s); } catch (e) { return input; }
    if (url.host !== location.host || under(url.pathname)) return input;
    url.pathname = P + url.pathname;
    return url.href;
  }
  function isApp(input) {
    try {
      var url = new URL(String(input && input.url !== undefined ? input.url : input), location.href);
      return url.host === location.host && under(url.pathname);
    } catch (e) { return false; }
  }
  function fixSrcset(v) {
    return String(v).split(",").map(function (c) {
      var m = /^(\\s*)(\\S+)([\\s\\S]*)$/.exec(c);
      return m ? m[1] + fix(m[2]) + m[3] : c;
    }).join(",");
  }
  function attempt(f) { try { f(); } catch (e) { /* this browser keeps its own */ } }

  attempt(function () {
    var original = window.fetch;
    if (!original) return;
    window.fetch = function (input, init) {
      if (typeof input === "string" || (typeof URL !== "undefined" && input instanceof URL)) {
        input = fix(input);
      } else if (input && typeof input.url === "string") {
        var fixed = fix(input.url);
        if (fixed !== input.url) attempt(function () { input = new Request(fixed, input); });
      }
      if (isApp(input) && !(init && init.credentials)) {
        if (input && typeof input.url === "string" && input.credentials === "same-origin") {
          attempt(function () { input = new Request(input, { credentials: "include" }); });
        } else {
          init = Object.assign({}, init, { credentials: "include" });
        }
      }
      return original.call(this, input, init);
    };
  });

  attempt(function () {
    var open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      args[1] = fix(url);
      var result = open.apply(this, args);
      if (isApp(args[1])) attempt(function () { this.withCredentials = true; }.bind(this));
      return result;
    };
  });

  function wrap(name, withCredentials) {
    attempt(function () {
      var Original = window[name];
      if (!Original) return;
      var Wrapped = function (url, options) {
        var target = fix(url);
        if (withCredentials && isApp(target)) options = Object.assign({ withCredentials: true }, options);
        return arguments.length > 1 || options !== undefined ? new Original(target, options) : new Original(target);
      };
      Wrapped.prototype = Original.prototype;
      Object.setPrototypeOf(Wrapped, Original);
      window[name] = Wrapped;
    });
  }
  wrap("WebSocket", false);
  wrap("EventSource", true);
  wrap("Worker", false);
  wrap("SharedWorker", false);

  attempt(function () {
    ["pushState", "replaceState"].forEach(function (m) {
      var original = History.prototype[m];
      History.prototype[m] = function (state, title, url) {
        return arguments.length > 2 && url != null ? original.call(this, state, title, fix(String(url))) : original.apply(this, arguments);
      };
    });
  });

  attempt(function () {
    ["assign", "replace"].forEach(function (m) {
      var original = location[m];
      location[m] = function (url) { return original.call(location, fix(String(url))); };
    });
  });

  // Where the Navigation API exists it catches the rest: a script setting
  // location.href to a root path, a link built with innerHTML.
  attempt(function () {
    if (!window.navigation || !navigation.addEventListener) return;
    navigation.addEventListener("navigate", function (e) {
      attempt(function () {
        if (!e.cancelable || e.hashChange || e.formData || e.downloadRequest) return;
        var url = new URL(e.destination.url);
        if (url.host !== location.host || under(url.pathname)) return;
        e.preventDefault();
        location.href = P + url.pathname + url.search + url.hash;
      });
    });
  });

  var CREDENTIALED = { SCRIPT: 1, LINK: 1 };
  function credentials(el, value) {
    if (CREDENTIALED[el.tagName] && isApp(value) && el.crossOrigin !== "use-credentials") {
      if (el.tagName === "SCRIPT" || /modulepreload/i.test(el.rel || "") || el.crossOrigin !== null) el.crossOrigin = "use-credentials";
    }
  }
  function patch(ctor, prop) {
    attempt(function () {
      var proto = window[ctor] && window[ctor].prototype;
      var d = proto && Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: function (v) {
          var fixed = prop === "srcset" ? fixSrcset(v) : fix(String(v));
          credentials(this, fixed);
          d.set.call(this, fixed);
        },
      });
    });
  }
  [
    ["HTMLImageElement", "src"], ["HTMLImageElement", "srcset"], ["HTMLSourceElement", "src"], ["HTMLSourceElement", "srcset"],
    ["HTMLMediaElement", "src"], ["HTMLVideoElement", "poster"], ["HTMLTrackElement", "src"], ["HTMLEmbedElement", "src"],
    ["HTMLLinkElement", "href"], ["HTMLScriptElement", "src"], ["HTMLAnchorElement", "href"], ["HTMLAreaElement", "href"],
    ["HTMLFormElement", "action"], ["HTMLIFrameElement", "src"], ["HTMLInputElement", "src"], ["HTMLInputElement", "formAction"],
    ["HTMLButtonElement", "formAction"],
  ].forEach(function (p) { patch(p[0], p[1]); });

  attempt(function () {
    var names = { src: 1, href: 1, action: 1, formaction: 1, poster: 1, srcset: 2, imagesrcset: 2 };
    var set = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      var n = String(name).toLowerCase();
      if (names[n] && (this instanceof HTMLElement || (typeof SVGElement !== "undefined" && this instanceof SVGElement))) {
        value = names[n] === 2 ? fixSrcset(value) : fix(String(value));
        credentials(this, value);
      }
      return set.call(this, name, value);
    };
  });

  // An opaque origin has no storage and no cookies of its own; where reading
  // them throws, the page gets in-memory ones instead (they reset on reload).
  function memoryStorage() {
    var m = new Map();
    return {
      get length() { return m.size; },
      key: function (i) { var k = Array.from(m.keys())[i]; return k === undefined ? null : k; },
      getItem: function (k) { k = String(k); return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { m.set(String(k), String(v)); },
      removeItem: function (k) { m.delete(String(k)); },
      clear: function () { m.clear(); },
    };
  }
  ["localStorage", "sessionStorage"].forEach(function (name) {
    var works = false;
    try { works = !!window[name]; } catch (e) { works = false; }
    if (works) return;
    var store = memoryStorage();
    attempt(function () { Object.defineProperty(window, name, { configurable: true, enumerable: true, get: function () { return store; } }); });
  });
  attempt(function () {
    try { void document.cookie; return; } catch (e) { /* throws: replace it */ }
    var jar = new Map();
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: function () { return Array.from(jar, function (kv) { return kv[0] ? kv[0] + "=" + kv[1] : kv[1]; }).join("; "); },
      set: function (v) {
        var parts = String(v).split(";");
        var first = parts.shift() || "";
        var eq = first.indexOf("=");
        var k = (eq === -1 ? "" : first.slice(0, eq)).trim();
        var val = (eq === -1 ? first : first.slice(eq + 1)).trim();
        var gone = parts.some(function (p) {
          var a = p.trim().toLowerCase();
          if (a.indexOf("max-age=") === 0) return Number(a.slice(8)) <= 0;
          if (a.indexOf("expires=") === 0) { var t = Date.parse(p.trim().slice(8)); return !isNaN(t) && t <= Date.now(); }
          return false;
        });
        if (gone) jar.delete(k); else jar.set(k, val);
      },
    });
  });
})();
`;
}
