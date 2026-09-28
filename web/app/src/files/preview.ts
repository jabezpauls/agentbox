import DOMPurify from "dompurify";
import { marked } from "marked";
import type { FileEntry } from "@workbench/shared";
import { rawUrl } from "./api.ts";
import { dirname, join } from "./paths.ts";

/**
 * Quick look: what a file can be shown as. Pictures and PDF are framed from
 * the files API as they are (it serves them under `CSP: sandbox`); Markdown
 * is rendered, sanitised; anything that reads as text is shown as text —
 * HTML and SVG included, as their source, never as a live page.
 */
export type PreviewKind = "image" | "pdf" | "markdown" | "text" | "none";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd"]);
/** Kinds that are never text, so quick look does not fetch them to find out. */
const BINARY = new Set([
  "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "jar", "war", "whl",
  "exe", "dll", "so", "dylib", "o", "a", "class", "wasm", "pyc", "node",
  "mp3", "wav", "flac", "ogg", "m4a", "mp4", "mov", "webm", "mkv", "avi",
  "woff", "woff2", "ttf", "otf", "eot", "psd", "sketch", "fig",
  "sqlite", "sqlite3", "db", "bin", "iso", "dmg", "img", "pdb", "heic", "tiff", "tif",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "key", "pages", "numbers",
]);

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function previewKind(entry: Pick<FileEntry, "name" | "type" | "targetType">): PreviewKind {
  const isFile = entry.type === "file" || (entry.type === "symlink" && entry.targetType === "file");
  if (!isFile) return "none";
  const ext = extOf(entry.name);
  if (IMAGE.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (MARKDOWN.has(ext)) return "markdown";
  if (BINARY.has(ext)) return "none";
  return "text";
}

/** How much of a text file quick look reads. */
export const TEXT_LIMIT = 256 * 1024;

export interface TextPreview {
  text: string;
  /** Only the start of the file was read. */
  truncated: boolean;
  /** The server did not serve it as text. */
  binary: boolean;
}

/** The start of a file as text, or `binary` when the server says it is not text. */
export async function readText(path: string, signal?: AbortSignal): Promise<TextPreview> {
  const res = await fetch(rawUrl(path, true), { headers: { range: `bytes=0-${TEXT_LIMIT - 1}` }, ...(signal ? { signal } : {}) });
  if (res.status === 416) return { text: "", truncated: false, binary: false };
  if (!res.ok) throw new Error(`The file could not be read (${res.status}).`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("text/")) return { text: "", truncated: false, binary: true };
  const text = await res.text();
  const total = Number(/\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1] ?? NaN);
  return { text, truncated: Number.isFinite(total) && total > TEXT_LIMIT, binary: false };
}

/** Resolve a relative link in a Markdown file against the file's folder. */
function resolveAgainst(base: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) return null;
  const clean = href.split(/[?#]/)[0] ?? "";
  if (!clean) return null;
  const parts = (clean.startsWith("/") ? clean : join(dirname(base), clean)).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(decodeURIComponentSafe(p));
  }
  return `/${out.join("/")}`;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Markdown as safe HTML. Sanitised with DOMPurify's HTML profile (no SVG, no
 * MathML, no script, no handlers, no forms or frames); links open in a new
 * tab without a referrer; a relative image is shown from the files API.
 */
export function renderMarkdown(source: string, filePath: string): string {
  const html = marked.parse(source, { async: false, gfm: true, breaks: false }) as string;
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed"],
    FORBID_ATTR: ["style"],
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment;
  for (const a of Array.from(clean.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) continue;
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
  for (const img of Array.from(clean.querySelectorAll("img[src]"))) {
    const local = resolveAgainst(filePath, img.getAttribute("src") ?? "");
    if (local) img.setAttribute("src", rawUrl(local, true));
    img.setAttribute("loading", "lazy");
    img.setAttribute("referrerpolicy", "no-referrer");
  }
  const holder = document.createElement("div");
  holder.appendChild(clean);
  return holder.innerHTML;
}
