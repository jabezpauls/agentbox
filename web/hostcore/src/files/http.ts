import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream";
import type { FileEntry } from "@workbench/shared";
import { describe, listDirectory, MAX_PAGE } from "./entries.js";
import { fsPath, parseQuery } from "./names.js";
import { disposition, etagOf, looksLikeText, parseRange } from "./raw.js";
import { fsError, FilesError } from "./roots.js";
import { searchNames } from "./search.js";
import type { FilesService } from "./service.js";

/**
 * The files API (`/api/files/*`) over plain `node:http`, for a machine's node:
 * the same shapes as the bridge's Fastify routes (routes.ts), so the
 * Workbench's file components work against `/m/<id>` unchanged, with what a
 * machine must do differently:
 *
 * - every answer is a type the gate passes from a machine (machines/respond.ts
 *   in the gate): JSON, `text/plain; charset=utf-8` for text shown inline,
 *   and `application/octet-stream` — always a download — for everything else;
 * - no git status (git runs what a repository's config names, and a folder
 *   the box may write is one whose `.git/config` it could write);
 * - no zip of folders (deferred: it would bring the zip library into the
 *   node), answered `501`;
 * - search results are held to the roots and the hidden list like listings.
 *
 * No Fastify, no zip library: the node bundles this.
 */

const MAX_JSON = 64 * 1024;
/** A write's body: its text (up to the ops' 4 MiB cap) as JSON. */
const MAX_WRITE_JSON = 6 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

function sendError(res: ServerResponse, err: unknown): void {
  const e = fsError(err, "path");
  if (!(e instanceof FilesError)) throw e;
  send(res, e.status, e.code ? { error: e.message, code: e.code } : { error: e.message });
}

function readBody(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new FilesError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") return resolve({});
      try {
        const v = JSON.parse(text) as unknown;
        if (typeof v === "object" && v !== null && !Array.isArray(v)) return resolve(v as Record<string, unknown>);
      } catch {
        // below
      }
      reject(new FilesError(400, "the body must be a JSON object"));
    });
    req.on("error", reject);
  });
}

function one(q: Map<string, string[]>, key: string): string | undefined {
  return q.get(key)?.[0];
}

function flag(q: Map<string, string[]>, key: string): boolean {
  const v = one(q, key);
  return v !== undefined && v !== "0" && v !== "false";
}

function int(q: Map<string, string[]>, key: string, fallback: number, min: number, max: number): number {
  const v = Number(one(q, key));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : fallback;
}

/** Fetch destinations that would run what they load as code. */
const CODE = new Set(["script", "worker", "sharedworker", "serviceworker", "style", "audioworklet", "paintworklet", "xslt"]);

async function isText(file: string, size: number): Promise<boolean> {
  if (size === 0) return true;
  const fh = await fsp.open(fsPath(file), "r");
  try {
    const buf = Buffer.alloc(Math.min(8192, size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return looksLikeText(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** A file's bytes: text shown inline when asked, everything else a download. */
async function raw(files: FilesService, req: IncomingMessage, res: ServerResponse, q: Map<string, string[]>): Promise<void> {
  const dest = req.headers["sec-fetch-dest"];
  if (typeof dest === "string" && CODE.has(dest.toLowerCase())) throw new FilesError(403, "a file cannot be loaded as a script or stylesheet", "not-code");
  const ref = await files.roots.target(one(q, "path"));
  const st = await fsp.stat(fsPath(ref.real));
  if (!st.isFile()) throw new FilesError(409, `${ref.abs} is not a file`, "not-a-file");
  const name = path.basename(ref.abs);
  const inline = flag(q, "inline") && (await isText(ref.real, st.size));
  const headers: Record<string, string> = {
    "content-type": inline ? "text/plain; charset=utf-8" : "application/octet-stream",
    "content-disposition": disposition(inline ? "inline" : "attachment", name),
    "cache-control": "private, no-cache",
    "last-modified": st.mtime.toUTCString(),
    etag: etagOf(st),
  };
  const range = parseRange(req.headers.range, st.size);
  if (range === "bad") {
    res.writeHead(416, { ...headers, "content-range": `bytes */${st.size}`, "content-length": "0" });
    res.end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : st.size - 1;
  const length = st.size === 0 ? 0 : end - start + 1;
  if (range) headers["content-range"] = `bytes ${start}-${end}/${st.size}`;
  headers["content-length"] = String(length);
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD" || length === 0) {
    res.end();
    return;
  }
  pipeline(createReadStream(fsPath(ref.real), { start, end }), res, () => {});
}

async function search(files: FilesService, q: Map<string, string[]>): Promise<FileEntry[]> {
  const { roots } = files;
  const dir = await roots.target(one(q, "path") ?? "");
  const rootReal = await roots.realRoot(dir.root);
  const found = await searchNames({
    dir: dir.real,
    query: one(q, "q") ?? "",
    limit: int(q, "limit", 50, 1, 200),
    ...(files.fd === undefined ? {} : { fd: files.fd }),
  });
  const out: FileEntry[] = [];
  for (const real of found) {
    // Never anything the listing would not show.
    if (!roots.inside(real, rootReal) || roots.hidden(real)) continue;
    try {
      out.push(await describe(roots.present(dir.root, rootReal, real), real, rootReal));
    } catch {
      // gone since the search ran
    }
  }
  return out;
}

/** The request fields that name a path. */
const PATH_IN = new Set(["path", "from", "to"]);
/** The answer fields that report one (a symlink's `target` is its text, not a path here). */
const PATH_OUT = new Set(["path", "originalPath"]);

function pathsIn(b: Record<string, unknown>, map: (p: string) => string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...b };
  for (const k of PATH_IN) if (typeof out[k] === "string") out[k] = map(out[k] as string);
  if (Array.isArray(out.paths)) out.paths = (out.paths as unknown[]).map((p) => (typeof p === "string" ? map(p) : p));
  return out;
}

function pathsOut(v: unknown, map: (p: string) => string): unknown {
  if (Array.isArray(v)) return v.map((x) => pathsOut(x, map));
  if (typeof v !== "object" || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === "missing" && Array.isArray(x)) out[k] = x.map((p) => (typeof p === "string" ? map(p) : p));
    else out[k] = PATH_OUT.has(k) && typeof x === "string" ? map(x) : typeof x === "object" ? pathsOut(x, map) : x;
  }
  return out;
}

const TRASH_ITEM = /^\/api\/files\/trash\/([0-9a-f]{24})(\/restore)?$/;
const UPLOAD = /^\/api\/files\/uploads\/([0-9a-f]{32})(\/finish)?$/;

/**
 * Answer `req` if it is a files request (`/api/files/…`); `false` when it is
 * not one, for the caller to answer.
 */
export async function serveFiles(files: FilesService, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? "/";
  const pathname = url.split("?", 1)[0] ?? "/";
  if (pathname !== "/api/files" && !pathname.startsWith("/api/files/")) return false;
  const method = req.method ?? "GET";
  const q = parseQuery(url);
  const { roots, ops, trash, uploads } = files;
  // Paths as the API spells them, in and out (a machine on Windows: `/C:/…`).
  const codec = files.apiPaths;
  if (codec) {
    const p = q.get("path");
    if (p) q.set("path", p.map((v) => codec.toHost(v)));
  }
  const body = async (r: IncomingMessage, max: number): Promise<Record<string, unknown>> => {
    const b = await readBody(r, max);
    return codec ? (pathsIn(b, codec.toHost) as Record<string, unknown>) : b;
  };
  const reply = (r: ServerResponse, status: number, v: unknown): void => send(r, status, codec ? pathsOut(v, codec.toApi) : v);
  try {
    const route = `${method} ${pathname}`;
    switch (route) {
      case "GET /api/files/list": {
        const dir = await roots.target(one(q, "path") ?? "");
        const st = await fsp.stat(fsPath(dir.real));
        if (!st.isDirectory()) throw new FilesError(409, `${dir.abs} is not a directory`, "not-a-directory");
        reply(
          res,
          200,
          await listDirectory(roots, dir, {
            hidden: flag(q, "hidden"),
            offset: int(q, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
            limit: int(q, "limit", MAX_PAGE, 1, MAX_PAGE),
            cache: files.listings,
          }),
        );
        return true;
      }
      case "GET /api/files/stat": {
        const ref = await roots.entry(one(q, "path") ?? "");
        reply(res, 200, await describe(ref.abs, ref.fs, await roots.realRoot(ref.root)));
        return true;
      }
      case "GET /api/files/raw":
      case "HEAD /api/files/raw":
        await raw(files, req, res, q);
        return true;
      case "GET /api/files/zip":
        reply(res, 501, { error: "folders cannot be downloaded as a zip from a machine yet; download its files one by one", code: "unsupported" });
        return true;
      case "GET /api/files/search":
        reply(res, 200, await search(files, q));
        return true;
      case "POST /api/files/write":
        reply(res, 200, await ops.write((await body(req, MAX_WRITE_JSON)) as Parameters<typeof ops.write>[0]));
        return true;
      case "POST /api/files/mkdir":
        reply(res, 200, await ops.mkdir(await body(req, MAX_JSON)));
        return true;
      case "POST /api/files/move":
        reply(res, 200, await ops.move((await body(req, MAX_JSON)) as Parameters<typeof ops.move>[0]));
        return true;
      case "POST /api/files/copy":
        reply(res, 200, await ops.copy((await body(req, MAX_JSON)) as Parameters<typeof ops.copy>[0]));
        return true;
      case "POST /api/files/trash":
        reply(res, 200, await trash.trash((await body(req, MAX_JSON)).paths));
        return true;
      case "GET /api/files/trash":
        reply(res, 200, await trash.list());
        return true;
      case "DELETE /api/files/trash":
        reply(res, 200, { removed: await trash.empty() });
        return true;
      case "POST /api/files/uploads": {
        const session = await uploads.start((await body(req, MAX_JSON)) as { path?: unknown; size?: unknown; overwrite?: unknown });
        reply(res, 200, { uploadId: session.id, ...session });
        return true;
      }
    }
    const t = TRASH_ITEM.exec(pathname);
    if (t) {
      const id = t[1] as string;
      if (t[2] && method === "POST") {
        reply(res, 200, await trash.restore(id, (await body(req, MAX_JSON)).to));
        return true;
      }
      if (!t[2] && method === "DELETE") {
        await trash.remove(id);
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return true;
      }
    }
    const u = UPLOAD.exec(pathname);
    if (u) {
      const id = u[1] as string;
      if (u[2] && method === "POST") {
        reply(res, 200, await uploads.finish(id));
        return true;
      }
      if (!u[2]) {
        if (method === "GET") {
          reply(res, 200, await uploads.get(id));
          return true;
        }
        if (method === "DELETE") {
          await uploads.cancel(id);
          res.writeHead(204, { "cache-control": "no-store" });
          res.end();
          return true;
        }
        if (method === "PUT") {
          const declared = req.headers["content-length"];
          const length = declared === undefined ? null : Number(declared);
          const done = await uploads.put(id, one(q, "offset"), req, Number.isFinite(length) ? length : null);
          // A refusal before the body was read: the connection cannot carry another request.
          if (!req.readableEnded) res.setHeader("connection", "close");
          reply(res, 200, done);
          return true;
        }
      }
    }
    reply(res, 404, { error: "not found" });
  } catch (err) {
    if (!req.readableEnded) res.setHeader("connection", "close");
    if (res.headersSent) res.destroy();
    else sendError(res, err);
  }
  return true;
}
