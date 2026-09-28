import DOMPurify from "dompurify";
import { marked } from "marked";
import { rawUrl } from "./api.ts";
import { dirname, join } from "./paths.ts";

/**
 * Markdown as safe HTML, for quick look. Loaded only when a Markdown file is
 * looked at: the parser and the sanitiser are the heaviest things in Files.
 *
 * A README is written by whoever wrote the repository — an agent, a stranger —
 * so the result is treated as hostile beyond "no script":
 *  - DOMPurify's HTML profile: no script, no handlers, no SVG or MathML;
 *  - no forms, frames, embeds, media or style sheets;
 *  - no `class`, `style`, `id`, `name`, `role`, `aria-*`, `tabindex` or `data-*`,
 *    so a file cannot borrow the app's own classes and draw what looks like
 *    the app's own "Session expired" dialog, clobber an id the app uses, or
 *    pose to assistive technology as a control;
 *  - pictures from elsewhere are not fetched unless asked for (a remote
 *    image tells its server that, and when, you looked).
 * The rendered block is also `contain: layout paint` in its own box, so even
 * what is allowed cannot be drawn outside it.
 */

export interface Rendered {
  html: string;
  /** Remote pictures left out; `remoteImages` loads them. */
  blocked: number;
}

const FORBID_TAGS = [
  "style", "form", "input", "button", "textarea", "select", "option", "iframe", "frame", "object", "embed",
  "video", "audio", "source", "track", "picture", "dialog", "template", "slot", "portal",
];
const FORBID_ATTR = [
  "style", "class", "id", "name", "role", "tabindex", "autofocus", "accesskey", "contenteditable",
  "draggable", "background", "srcset", "sizes", "popover", "form", "formaction",
];

/** A relative link or picture in a Markdown file, resolved against the file's folder. */
function resolveAgainst(base: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) return null;
  const clean = href.split(/[?#]/)[0] ?? "";
  if (!clean) return null;
  const parts = (clean.startsWith("/") ? clean : join(dirname(base), clean)).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else {
      try {
        out.push(decodeURIComponent(p));
      } catch {
        out.push(p);
      }
    }
  }
  return `/${out.join("/")}`;
}

function isRemote(src: string): boolean {
  return /^(https?:)?\/\//i.test(src);
}

export function renderMarkdown(source: string, filePath: string, opts: { remoteImages?: boolean } = {}): Rendered {
  const html = marked.parse(source, { async: false, gfm: true, breaks: false }) as string;
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment;

  for (const a of Array.from(clean.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      // In-page anchors have nothing to land on: ids are gone.
      a.removeAttribute("href");
      continue;
    }
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }

  let blocked = 0;
  for (const img of Array.from(clean.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    img.setAttribute("loading", "lazy");
    img.setAttribute("referrerpolicy", "no-referrer");
    if (isRemote(src)) {
      if (opts.remoteImages) continue;
      blocked++;
      const note = document.createElement("span");
      note.className = "md-remote";
      note.textContent = img.getAttribute("alt") || "Remote image";
      note.title = src;
      img.replaceWith(note);
      continue;
    }
    if (/^data:image\//i.test(src)) continue;
    const local = resolveAgainst(filePath, src);
    if (local) img.setAttribute("src", rawUrl(local, true));
    else img.removeAttribute("src");
  }

  const holder = document.createElement("div");
  holder.appendChild(clean);
  return { html: holder.innerHTML, blocked };
}
