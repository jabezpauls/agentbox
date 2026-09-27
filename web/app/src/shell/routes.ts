import type { FileRoot } from "@workbench/shared";

/**
 * The app's routes. Every surface has a path of its own, so a link, a reload
 * or the back button lands exactly where it pointed:
 *
 *   /                      Home
 *   /workbench             the Workbench (`?review=<key>` opens that review in the dock)
 *   /editor                the editor
 *   /files/<path>          Files, at a folder or a file below the workspace
 *   /files/~/<path>        … below home
 *   /files?trash=1         the trash
 *   /apps, /apps/<id>      Apps, optionally with one app selected
 *   /system[/monitor]      System, or its detailed monitor
 *   /settings/<section>    Settings
 *
 * `/settings/devices` is not here on purpose: that path is the gate's own
 * device-approval page, served from outside the sandbox, so Settings calls
 * its devices section `cli`.
 */

export type SurfaceId = "home" | "workbench" | "editor" | "files" | "apps" | "system" | "settings";
export type SettingsSection = "account" | "cli" | "sharing" | "appearance" | "about";
export const SETTINGS_SECTIONS: SettingsSection[] = ["account", "cli", "sharing", "appearance", "about"];

export type Route =
  | { surface: "home" }
  | { surface: "workbench"; review?: string }
  | { surface: "editor" }
  | { surface: "files"; root: FileRoot; rel: string[]; trash?: true }
  | { surface: "apps"; appId?: string }
  | { surface: "system"; view: "overview" | "monitor" }
  | { surface: "settings"; section: SettingsSection };

const REVIEW_KEY = /^[0-9a-f]{8}$/;
const APP_ID = /^[a-z0-9]{1,64}$/;

/**
 * Percent-encode one path segment. A name that is not valid UTF-8 carries
 * each stray byte as the lone surrogate U+DC80 + (byte − 0x80) — the files
 * API's convention — and that travels as the raw byte, `%XX`.
 */
export function encodeSegment(name: string): string {
  let out = "";
  for (const ch of name) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xdc80 && cp <= 0xdcff) {
      out += `%${(cp - 0xdc00).toString(16).toUpperCase()}`;
      continue;
    }
    try {
      out += encodeURIComponent(ch);
    } catch {
      // Another lone surrogate: nothing the files API ever sends.
      out += "%EF%BF%BD";
    }
  }
  return out;
}

/** UTF-8 bytes to a string, a byte that is not part of a valid sequence becoming its lone surrogate. */
function decodeBytes(bytes: number[]): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
      continue;
    }
    const len = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    let cp = len === 2 ? b & 0x1f : len === 3 ? b & 0x0f : b & 0x07;
    let ok = len > 0 && i + len <= bytes.length;
    for (let k = 1; ok && k < len; k++) {
      const c = bytes[i + k]!;
      if ((c & 0xc0) !== 0x80) ok = false;
      else cp = (cp << 6) | (c & 0x3f);
    }
    // Overlong forms, UTF-16 surrogates and values past U+10FFFF are not UTF-8.
    if (ok && ((len === 3 && cp < 0x800) || (len === 4 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff))) {
      ok = false;
    }
    if (ok) {
      out += String.fromCodePoint(cp);
      i += len;
    } else {
      out += String.fromCharCode(0xdc00 + b);
      i += 1;
    }
  }
  return out;
}

/** The inverse of {@link encodeSegment}. */
export function decodeSegment(raw: string): string {
  let out = "";
  let bytes: number[] = [];
  const flush = () => {
    if (bytes.length) out += decodeBytes(bytes);
    bytes = [];
  };
  for (let i = 0; i < raw.length; i++) {
    const hex = raw[i] === "%" ? raw.slice(i + 1, i + 3) : "";
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      flush();
      out += raw[i];
    }
  }
  flush();
  return out;
}

/** Split a decoded path into its names, dropping empty and dot segments. */
function names(segments: string[]): string[] {
  return segments.filter((s) => s !== "" && s !== "." && s !== "..");
}

function filesRoute(parts: string[], params: URLSearchParams, search: string): Route {
  if (params.get("trash") === "1") return { surface: "files", root: "workspace", rel: [], trash: true };
  // The query form carries paths the path form cannot (see pathFor). It is
  // read raw, not through URLSearchParams, which would decode a stray byte
  // into a replacement character.
  const p = /[?&]p=([^&]*)/.exec(search)?.[1];
  if (p !== undefined && parts.length === 0) {
    const segs = p.split(/%2F/i).map(decodeSegment);
    const home = segs[0] === "~";
    return { surface: "files", root: home ? "home" : "workspace", rel: names(home ? segs.slice(1) : segs) };
  }
  const decoded = parts.map(decodeSegment);
  if (decoded[0] === "~") return { surface: "files", root: "home", rel: names(decoded.slice(1)) };
  return { surface: "files", root: "workspace", rel: names(decoded) };
}

/** The route a location names. Anything unknown is Home. */
export function parseRoute(pathname: string, search = ""): Route {
  const params = new URLSearchParams(search);
  const parts = pathname.split("/").filter((s) => s !== "");
  const [head, ...rest] = parts;
  switch (head) {
    case undefined:
      return { surface: "home" };
    case "workbench": {
      const review = params.get("review");
      return review && REVIEW_KEY.test(review) ? { surface: "workbench", review } : { surface: "workbench" };
    }
    case "editor":
      return { surface: "editor" };
    case "files":
      return filesRoute(rest, params, search);
    case "apps":
      return rest[0] && APP_ID.test(rest[0]) ? { surface: "apps", appId: rest[0] } : { surface: "apps" };
    case "system":
      return { surface: "system", view: rest[0] === "monitor" ? "monitor" : "overview" };
    case "settings": {
      const section = SETTINGS_SECTIONS.find((s) => s === rest[0]) ?? "account";
      return { surface: "settings", section };
    }
    default:
      return { surface: "home" };
  }
}

/**
 * The path for a route. Files names go in the path, one encoded segment each;
 * a name with a backslash cannot (the gate refuses `%5c` and `\` in a path,
 * so no reading of it can differ between parsers) and such a path goes in the
 * query instead, which the gate leaves alone.
 */
export function pathFor(route: Route): string {
  switch (route.surface) {
    case "home":
      return "/";
    case "workbench":
      return route.review ? `/workbench?review=${route.review}` : "/workbench";
    case "editor":
      return "/editor";
    case "files": {
      if (route.trash) return "/files?trash=1";
      const prefix = route.root === "home" ? ["~"] : [];
      if (route.rel.some((n) => n.includes("\\"))) {
        const p = [route.root === "home" ? "~" : "", ...route.rel.map(encodeSegment)].join("%2F");
        return `/files?p=${p}`;
      }
      const segs = [...prefix, ...route.rel.map(encodeSegment)];
      return segs.length ? `/files/${segs.join("/")}` : "/files";
    }
    case "apps":
      return route.appId ? `/apps/${route.appId}` : "/apps";
    case "system":
      return route.view === "monitor" ? "/system/monitor" : "/system";
    case "settings":
      return `/settings/${route.section}`;
  }
}

/** Two routes are the same place. */
export function sameRoute(a: Route, b: Route): boolean {
  return pathFor(a) === pathFor(b);
}
