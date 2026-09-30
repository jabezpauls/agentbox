import { randomBytes } from "node:crypto";
import type http from "node:http";
import { json, stubServer, TOKEN, type Stub } from "./helpers.js";

/**
 * A stand-in for the bridge's files API behind the gate, in memory, with the
 * same contract as web/bridge/src/files: absolute paths (relative ones hang
 * off /workspace), `{error, code}` refusals, and chunked uploads that accept
 * a chunk at any offset up to what has arrived and refuse one beyond it with
 * `offset:N`.
 */

export interface Node {
  type: "file" | "dir" | "symlink";
  data: Buffer;
  mtime: number;
  /** A link's text. */
  target?: string;
}

export interface FilesStub extends Stub {
  fs: Map<string, Node>;
  uploads: Map<string, { path: string; size: number; data: Buffer; received: number; overwrite: boolean; done: boolean }>;
  trashed: string[];
  writes: Array<{ path: string; overwrite: boolean }>;
  /**
   * Called before each chunk is taken: "drop" cuts the connection without
   * taking it, "lost" takes it and then cuts the connection (the answer is
   * lost), a status refuses it.
   */
  chunkHook: ((n: number, offset: number) => "drop" | "lost" | number | void) | null;
  chunkCount: number;
  bytesTaken: number;
}

function norm(p: string): string {
  let abs = p === "" ? "/workspace" : p.startsWith("/") ? p : p.startsWith("~") ? `/home/coder${p.slice(1)}` : `/workspace/${p}`;
  const parts: string[] = [];
  for (const s of abs.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") parts.pop();
    else parts.push(s);
  }
  abs = `/${parts.join("/")}`;
  return abs;
}

function parent(p: string): string {
  return p.slice(0, p.lastIndexOf("/")) || "/";
}

function entry(p: string, n: Node, fsMap?: Map<string, Node>): Record<string, unknown> {
  const e: Record<string, unknown> = { name: p.slice(p.lastIndexOf("/") + 1), path: p, type: n.type, size: n.type === "file" ? n.data.length : 0, mtime: n.mtime };
  if (n.type === "symlink") {
    e.target = n.target;
    const to = fsMap?.get(norm(n.target?.startsWith("/") ? n.target : `${parent(p)}/${n.target}`));
    e.targetType = to ? to.type : null;
  }
  return e;
}

export async function filesStub(): Promise<FilesStub> {
  const fs = new Map<string, Node>([
    ["/workspace", { type: "dir", data: Buffer.alloc(0), mtime: 1 }],
    ["/home/coder", { type: "dir", data: Buffer.alloc(0), mtime: 1 }],
  ]);
  const uploads: FilesStub["uploads"] = new Map();
  let clock = 1000;

  const fail = (res: http.ServerResponse, status: number, error: string, code?: string): void => json(res, status, code ? { error, code } : { error });

  const stub = (await stubServer((req, res, body) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return fail(res, 401, "unauthorized");
    const url = new URL(req.url ?? "/", "http://x");
    const q = (k: string): string => url.searchParams.get(k) ?? "";
    const b = (): Record<string, unknown> => (body.length ? (JSON.parse(body.toString()) as Record<string, unknown>) : {});
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /_gate/version") return json(res, 200, { version: "0.0.0-dev" });
    if (route === "DELETE /_gate/tokens/self") return json(res, 200, { revoked: true });
    if (route === "GET /api/files/stat") {
      const p = norm(q("path"));
      const n = fs.get(p);
      return n ? json(res, 200, entry(p, n, fs)) : fail(res, 404, `${p} does not exist`, "not-found");
    }
    if (route === "GET /api/files/list") {
      const p = norm(q("path"));
      const n = fs.get(p);
      if (!n) return fail(res, 404, `${p} does not exist`, "not-found");
      if (n.type !== "dir") return fail(res, 409, `${p} is not a directory`, "not-a-directory");
      const hidden = url.searchParams.has("hidden");
      const all = [...fs.entries()]
        .filter(([k]) => parent(k) === p && k !== p)
        .filter(([k]) => hidden || !k.slice(k.lastIndexOf("/") + 1).startsWith("."))
        .sort(([a, x], [c, y]) => (x.type === y.type ? a.localeCompare(c) : x.type === "dir" ? -1 : 1));
      const offset = Number(q("offset") || 0);
      const limit = Number(q("limit") || 2);
      const page = all.slice(offset, offset + limit);
      return json(res, 200, { path: p, root: "workspace", entries: page.map(([k, v]) => entry(k, v)), total: all.length, offset, truncated: offset + page.length < all.length });
    }
    if (route === "GET /api/files/raw") {
      const p = norm(q("path"));
      const n = fs.get(p);
      if (!n) return fail(res, 404, `${p} does not exist`, "not-found");
      if (n.type !== "file") return fail(res, 409, `${p} is not a file`, "not-a-file");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(n.data.length) });
      return void res.end(n.data);
    }
    if (route === "POST /api/files/mkdir") {
      const p = norm(String(b().path));
      const segs = p.split("/").filter(Boolean);
      let cur = "";
      for (const s of segs) {
        cur += `/${s}`;
        const n = fs.get(cur);
        if (n && n.type !== "dir") return fail(res, 409, `${cur} exists and is not a directory`, "exists");
        if (!n) fs.set(cur, { type: "dir", data: Buffer.alloc(0), mtime: clock++ });
      }
      return json(res, 200, entry(p, fs.get(p) as Node));
    }
    if (route === "POST /api/files/write") {
      const { path: raw, content, overwrite } = b() as { path: string; content: string; overwrite?: boolean };
      const p = norm(raw);
      stub.writes.push({ path: p, overwrite: overwrite === true });
      if (fs.has(p) && overwrite !== true) return fail(res, 409, `${p} already exists`, "exists");
      if (!fs.has(parent(p))) return fail(res, 404, `${parent(p)} does not exist`, "not-found");
      fs.set(p, { type: "file", data: Buffer.from(content, "utf8"), mtime: clock++ });
      return json(res, 200, entry(p, fs.get(p) as Node));
    }
    if (route === "POST /api/files/move" || route === "POST /api/files/copy") {
      const { from, to, overwrite } = b() as { from: string; to: string; overwrite?: boolean };
      const src = norm(from);
      const dest = norm(to);
      if (!fs.has(src)) return fail(res, 404, `${src} does not exist`, "not-found");
      if (fs.has(dest) && overwrite !== true) return fail(res, 409, `${dest} already exists`, "exists");
      for (const [k, v] of [...fs.entries()]) {
        if (k === src || k.startsWith(`${src}/`)) {
          fs.set(dest + k.slice(src.length), { ...v, data: Buffer.from(v.data) });
          if (route.endsWith("move")) fs.delete(k);
        }
      }
      return json(res, 200, entry(dest, fs.get(dest) as Node));
    }
    if (route === "POST /api/files/trash") {
      const paths = (b().paths as string[]).map(norm);
      const trashed = [];
      const missing = [];
      for (const p of paths) {
        if (!fs.has(p)) {
          missing.push(p);
          continue;
        }
        for (const k of [...fs.keys()]) if (k === p || k.startsWith(`${p}/`)) fs.delete(k);
        stub.trashed.push(p);
        trashed.push({ id: randomBytes(4).toString("hex"), originalPath: p });
      }
      return json(res, 200, { trashed, missing });
    }
    if (route === "POST /api/files/uploads") {
      const { path: raw, size, overwrite } = b() as { path: string; size: number; overwrite?: boolean };
      const p = norm(raw);
      const existing = fs.get(p);
      if (existing?.type === "dir") return fail(res, 409, `${p} is a directory`, "is-a-directory");
      if (existing && overwrite !== true) return fail(res, 409, `${p} already exists`, "exists");
      const id = randomBytes(16).toString("hex");
      uploads.set(id, { path: p, size, data: Buffer.alloc(size), received: 0, overwrite: overwrite === true, done: false });
      return json(res, 200, { uploadId: id, id, path: p, size, received: 0, overwrite: overwrite === true, created: 1, updated: 1, done: false });
    }
    const m = /^\/api\/files\/uploads\/([0-9a-f]{32})(\/finish)?$/.exec(url.pathname);
    if (m) {
      const up = uploads.get(m[1] as string);
      if (!up) return fail(res, 404, "no such upload", "not-found");
      const view = (): Record<string, unknown> => ({ id: m[1], path: up.path, size: up.size, received: up.received, overwrite: up.overwrite, created: 1, updated: 1, done: up.done });
      if (req.method === "GET") return json(res, 200, view());
      if (req.method === "DELETE") {
        uploads.delete(m[1] as string);
        res.writeHead(204);
        return void res.end();
      }
      if (req.method === "POST" && m[2]) {
        if (up.received !== up.size) return fail(res, 409, `only ${up.received} of ${up.size} bytes have arrived`, `offset:${up.received}`);
        if (!up.done) {
          if (fs.has(up.path) && !up.overwrite) return fail(res, 409, `${up.path} already exists`, "exists");
          if (fs.has(up.path)) stub.trashed.push(up.path);
          fs.set(up.path, { type: "file", data: up.data, mtime: clock++ });
          up.done = true;
        }
        return json(res, 200, entry(up.path, fs.get(up.path) as Node));
      }
      if (req.method === "PUT") {
        const offset = Number(q("offset"));
        const verdict = stub.chunkHook?.(stub.chunkCount, offset);
        stub.chunkCount += 1;
        if (verdict === "drop") return void req.socket.destroy();
        if (typeof verdict === "number") return fail(res, verdict, `refused (${verdict})`);
        if (offset > up.received) return fail(res, 409, `expected a chunk at offset ${up.received}`, `offset:${up.received}`);
        body.copy(up.data, offset);
        stub.bytesTaken += body.length;
        up.received = Math.max(up.received, offset + body.length);
        if (verdict === "lost") return void req.socket.destroy();
        return json(res, 200, view());
      }
    }
    fail(res, 404, "not found");
  })) as FilesStub;
  stub.fs = fs;
  stub.uploads = uploads;
  stub.trashed = [];
  stub.writes = [];
  stub.chunkHook = null;
  stub.chunkCount = 0;
  stub.bytesTaken = 0;
  return stub;
}

export function put(stub: FilesStub, p: string, content: string | Buffer | null): void {
  stub.fs.set(p, content === null ? { type: "dir", data: Buffer.alloc(0), mtime: 5 } : { type: "file", data: Buffer.from(content), mtime: 5 });
}

export function link(stub: FilesStub, p: string, target: string): void {
  stub.fs.set(p, { type: "symlink", data: Buffer.alloc(0), mtime: 5, target });
}

export function read(stub: FilesStub, p: string): string | null {
  const n = stub.fs.get(p);
  return n && n.type === "file" ? n.data.toString() : null;
}
