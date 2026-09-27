import type { Readable } from "node:stream";
import { ApiError } from "./errors.js";
import type { BoxClient, Response } from "./http.js";
import type { FileEntry, FileListing, TrashResult, UploadSession } from "./remote.js";

/**
 * The box's files API (`/api/files/*`), typed. Paths are the box's: absolute,
 * or relative to the workspace, or `~/…` for home; every answer names paths
 * absolutely, and those are what the CLI builds on.
 */

/** The largest chunk the box takes in one request (under Cloudflare's 100 MB body cap). */
export const MAX_CHUNK = 50 * 1024 * 1024;
/** A folder is listed this many entries a page. */
export const PAGE = 5000;

/**
 * Percent-encode a path for a query string. A file name that is not UTF-8
 * arrives from the box with each stray byte as U+DC80 + byte; it goes back as
 * that byte, so such a file can still be fetched or removed.
 */
export function encodePathParam(p: string): string {
  let out = "";
  for (const ch of p) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp >= 0xdc80 && cp <= 0xdcff ? `%${(cp - 0xdc00).toString(16).toUpperCase()}` : encodeURIComponent(ch);
  }
  return out;
}

/** `dir` + `/` + `name`, for paths on the box. */
export function joinRemote(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

/** The last part of a path on the box. */
export function remoteBase(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export class FilesApi {
  constructor(readonly client: BoxClient) {}

  private q(p: string): string {
    return `path=${encodePathParam(p)}`;
  }

  list(p: string, opts: { hidden?: boolean; offset?: number; limit?: number } = {}): Promise<FileListing> {
    const extra = [
      opts.hidden ? "hidden=1" : "",
      opts.offset ? `offset=${opts.offset}` : "",
      opts.limit ? `limit=${opts.limit}` : "",
    ].filter(Boolean);
    return this.client.json<FileListing>("GET", "/api/files/list", { rawQuery: [this.q(p), ...extra].join("&"), what: `listing ${p || "the workspace"}` });
  }

  /** Every entry of a folder, across pages. */
  async listAll(p: string, hidden = false): Promise<FileListing> {
    const first = await this.list(p, { hidden });
    const entries = [...first.entries];
    let offset = first.entries.length;
    let truncated = first.truncated;
    while (truncated && offset < first.total) {
      const next = await this.list(p, { hidden, offset });
      if (next.entries.length === 0) break;
      entries.push(...next.entries);
      offset += next.entries.length;
      truncated = next.truncated;
    }
    return { ...first, entries, offset: 0, truncated: false };
  }

  /** One entry, or `null` when there is nothing there. */
  async stat(p: string): Promise<FileEntry | null> {
    try {
      return await this.client.json<FileEntry>("GET", "/api/files/stat", { rawQuery: this.q(p), what: p });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** The file's bytes, as a stream. */
  raw(p: string, signal?: AbortSignal): Promise<Response> {
    return this.client.ok("GET", "/api/files/raw", { rawQuery: this.q(p), what: `reading ${p}`, idleMs: 120_000, ...(signal ? { signal } : {}) });
  }

  write(p: string, content: string, overwrite: boolean): Promise<FileEntry> {
    return this.client.json<FileEntry>("POST", "/api/files/write", { body: { json: { path: p, content, overwrite } }, what: `saving ${p}` });
  }

  mkdir(p: string): Promise<FileEntry> {
    return this.client.json<FileEntry>("POST", "/api/files/mkdir", { body: { json: { path: p } }, what: `making ${p}` });
  }

  move(from: string, to: string, overwrite: boolean): Promise<FileEntry> {
    return this.client.json<FileEntry>("POST", "/api/files/move", { body: { json: { from, to, overwrite } }, what: `moving ${from}` });
  }

  copy(from: string, to: string, overwrite: boolean): Promise<FileEntry> {
    return this.client.json<FileEntry>("POST", "/api/files/copy", { body: { json: { from, to, overwrite } }, what: `copying ${from}`, idleMs: 600_000 });
  }

  trash(paths: string[]): Promise<TrashResult> {
    return this.client.json<TrashResult>("POST", "/api/files/trash", { body: { json: { paths } }, what: "moving to the trash" });
  }

  startUpload(p: string, size: number, overwrite: boolean): Promise<UploadSession & { uploadId: string }> {
    return this.client.json("POST", "/api/files/uploads", { body: { json: { path: p, size, overwrite } }, what: `uploading to ${p}` });
  }

  getUpload(id: string): Promise<UploadSession> {
    return this.client.json("GET", `/api/files/uploads/${encodeURIComponent(id)}`, { what: "checking the upload" });
  }

  /** Send `length` bytes from `body` at `offset`. */
  putChunk(id: string, offset: number, body: Readable, length: number, signal?: AbortSignal): Promise<UploadSession> {
    return this.client.json("PUT", `/api/files/uploads/${encodeURIComponent(id)}`, {
      query: { offset },
      body,
      headers: { "content-type": "application/octet-stream", "content-length": String(length) },
      what: "uploading",
      idleMs: 120_000,
      ...(signal ? { signal } : {}),
    });
  }

  finishUpload(id: string): Promise<FileEntry> {
    return this.client.json("POST", `/api/files/uploads/${encodeURIComponent(id)}/finish`, { what: "finishing the upload", idleMs: 300_000 });
  }

  cancelUpload(id: string): Promise<void> {
    return this.client.json("DELETE", `/api/files/uploads/${encodeURIComponent(id)}`, { what: "cancelling the upload" });
  }
}
