import { createReadStream, type Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { encodeName, fsPath } from "./names.js";

/**
 * Every byte the files API hands a browser carries these. `sandbox` gives the
 * response an opaque origin with scripts off even when it is opened as a
 * top-level tab, so a file an agent wrote can never run as the box's own
 * origin; `nosniff` stops the browser from deciding a text file is HTML.
 */
export const FILE_HEADERS: Record<string, string> = {
  "content-security-policy": "sandbox",
  "x-content-type-options": "nosniff",
  "cache-control": "private, no-cache",
};

/** Types a browser may show inline: pictures and PDF. Never HTML or SVG. */
const INLINE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

/** Types for downloads, so the saved file opens with the right program. */
const DOWNLOAD_TYPES: Record<string, string> = {
  ...INLINE_TYPES,
  ".html": "text/html",
  ".htm": "text/html",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
};

/** True when the first bytes of a file look like text: valid UTF-8, no NULs. */
export function looksLikeText(head: Buffer): boolean {
  if (head.includes(0)) return false;
  // A multi-byte character may be cut at the end of the sample.
  for (let cut = 0; cut < 4 && cut <= head.length; cut++) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, head.length - cut));
      return true;
    } catch {
      // try a shorter prefix
    }
  }
  return false;
}

/**
 * `Content-Disposition` for a name that may hold anything a filename can —
 * quotes, newlines, bytes that are not UTF-8. The ASCII fallback is scrubbed
 * of everything a header cannot carry; the RFC 5987 form carries the exact
 * bytes.
 */
export function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%;]/g, "_") || "download";
  const exact = [...encodeName(name)]
    .map((b) => (/[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`))
    .join("");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${exact}`;
}

/** A single `bytes=` range, or null for none, or "bad" when unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "bad" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Multiple ranges and other units are allowed to be ignored (RFC 9110).
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  let start: number;
  let end: number;
  if (a === "") {
    const n = Number(b);
    if (n === 0) return "bad";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return "bad";
  return { start, end };
}

/**
 * Send a regular file. `inline` is honoured only for pictures, PDF and text
 * (served as `text/plain`); everything else — HTML and SVG above all — goes
 * out as an attachment. Single byte ranges are supported, for media and for
 * resuming a download.
 */
export async function sendFile(
  req: FastifyRequest,
  reply: FastifyReply,
  file: string,
  name: string,
  st: Stats,
  inline: boolean,
): Promise<FastifyReply> {
  const ext = path.extname(name).toLowerCase();
  let type = DOWNLOAD_TYPES[ext] ?? "application/octet-stream";
  let kind: "inline" | "attachment" = "attachment";
  if (inline) {
    if (INLINE_TYPES[ext]) {
      kind = "inline";
      type = INLINE_TYPES[ext]!;
    } else if (await isText(file, st)) {
      // HTML, SVG, source code: shown as the text they are, never rendered.
      kind = "inline";
      type = "text/plain; charset=utf-8";
    }
  }

  reply.headers(FILE_HEADERS);
  reply.header("content-type", type);
  reply.header("content-disposition", disposition(kind, name));
  reply.header("last-modified", st.mtime.toUTCString());
  reply.header("etag", `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`);
  reply.header("accept-ranges", "bytes");

  const range = parseRange(req.headers.range, st.size);
  if (range === "bad") {
    return reply.code(416).header("content-range", `bytes */${st.size}`).send();
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : st.size - 1;
  const length = st.size === 0 ? 0 : end - start + 1;
  if (range) reply.code(206).header("content-range", `bytes ${start}-${end}/${st.size}`);
  reply.header("content-length", String(length));
  if (req.method === "HEAD" || length === 0) return reply.send();
  return reply.send(createReadStream(fsPath(file), { start, end }));
}

async function isText(file: string, st: Stats): Promise<boolean> {
  if (st.size === 0) return true;
  const fh = await fsp.open(fsPath(file), "r");
  try {
    const buf = Buffer.alloc(Math.min(8192, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return looksLikeText(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}
