import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileEntry, UploadSession } from "@workbench/shared";
import { describe } from "./entries.js";
import { fsPath } from "./names.js";
import { fsError, FilesError, type Root, type Roots } from "./roots.js";
import { noClobberRename, removeTree } from "./tree.js";

/**
 * The largest chunk one request may carry: 50 MiB, under Cloudflare's 100 MB
 * request-body cap with room to spare.
 */
export const MAX_CHUNK = 50 * 1024 * 1024;
/** Uploads nobody has touched for this long are abandoned and swept. */
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const UPLOAD_ID = /^[0-9a-f]{32}$/;

interface Record extends UploadSession {
  v: 1;
  root: Root["id"];
  /** Set once finished, so a repeated finish answers the same. */
  entry?: FileEntry;
}

/**
 * Chunked uploads: start, send chunks at offsets, finish.
 *
 * Every step is safe to repeat, because networks drop requests after the
 * server has acted on them:
 *  - a chunk may be resent at any offset up to what has been received — the
 *    same bytes are written again over themselves;
 *  - a chunk beyond what has been received is refused with the offset to
 *    resume from, never written with a hole before it;
 *  - finishing twice answers the second time with what the first produced.
 *
 * The data goes to `<root>/.agentbox/uploads/<id>.part` on the destination's
 * own volume and is renamed into place on finish, so a half-sent file never
 * appears under its real name. Anything untouched for a day is swept.
 */
export class Uploads {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly roots: Roots,
    private readonly opts: { maxChunk?: number; ttlMs?: number } = {},
  ) {}

  private dir(root: Root): string {
    return path.join(this.roots.stateDir(root), "uploads");
  }

  /** Run `work` after any earlier work on the same upload has settled. */
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(id) ?? Promise.resolve();
    const next = prev.then(work, work);
    const tail = next.then(
      () => {},
      () => {},
    );
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return next;
  }

  async start(body: { path?: unknown; size?: unknown; overwrite?: unknown }): Promise<UploadSession> {
    const size = body.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new FilesError(400, "size must be a byte count");
    }
    const overwrite = body.overwrite === true;
    const dest = await this.roots.creatable(body.path);
    this.roots.assertMutable(dest);
    await this.checkDestination(dest.fs, dest.abs, overwrite);

    const root = dest.root;
    const dir = this.dir(root);
    await fsp.mkdir(dir, { recursive: true });
    // Refuse up front what cannot fit, rather than at 99%.
    const fsStat = await fsp.statfs(dir);
    if (size > fsStat.bavail * fsStat.bsize) {
      throw new FilesError(507, "not enough space left on the volume for this upload", "no-space");
    }

    const id = randomBytes(16).toString("hex");
    const now = Date.now();
    const rec: Record = {
      v: 1,
      id,
      root: root.id,
      path: dest.abs,
      size,
      received: 0,
      overwrite,
      created: now,
      updated: now,
      done: false,
    };
    await fsp.writeFile(path.join(dir, `${id}.part`), "");
    await this.save(rec);
    return view(rec);
  }

  private async checkDestination(fs: string, abs: string, overwrite: boolean): Promise<void> {
    try {
      const st = await fsp.lstat(fsPath(fs));
      if (st.isDirectory()) throw new FilesError(409, `${abs} is a directory`, "is-a-directory");
      if (!overwrite) throw new FilesError(409, `${abs} already exists`, "exists");
    } catch (err) {
      if (err instanceof FilesError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw fsError(err, abs);
    }
  }

  private async save(rec: Record): Promise<void> {
    const file = path.join(this.dir(this.roots.byId(rec.root)), `${rec.id}.json`);
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(rec));
    await fsp.rename(tmp, file);
  }

  private async load(id: string): Promise<Record> {
    if (!UPLOAD_ID.test(id)) throw new FilesError(400, "invalid upload id");
    for (const root of this.roots.list()) {
      try {
        const rec = JSON.parse(await fsp.readFile(path.join(this.dir(root), `${id}.json`), "utf8")) as Record;
        if (rec.id === id) return rec;
      } catch {
        // not in this root
      }
    }
    throw new FilesError(404, "no such upload", "not-found");
  }

  async get(id: string): Promise<UploadSession> {
    return view(await this.load(id));
  }

  /**
   * Write one chunk at `offset`. `length` is the declared body length when the
   * request gave one, checked before a byte is read.
   */
  put(id: string, offset: unknown, body: Readable, length: number | null): Promise<UploadSession> {
    return this.serial(id, async () => {
      const rec = await this.load(id);
      if (rec.done) throw new FilesError(409, "this upload has already finished", "finished");
      const at = Number(offset);
      if (!Number.isSafeInteger(at) || at < 0) throw new FilesError(400, "offset must be a byte offset");
      if (at > rec.received) {
        throw new FilesError(409, `expected a chunk at offset ${rec.received}`, `offset:${rec.received}`);
      }
      const max = this.opts.maxChunk ?? MAX_CHUNK;
      if (length !== null && length > max) throw new FilesError(413, `a chunk may be at most ${max} bytes`, "too-large");
      if (length !== null && at + length > rec.size) {
        throw new FilesError(400, "the chunk runs past the declared size", "past-end");
      }

      let written = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length;
          if (written > max) cb(new FilesError(413, `a chunk may be at most ${max} bytes`, "too-large"));
          else if (at + written > rec.size) cb(new FilesError(400, "the chunk runs past the declared size", "past-end"));
          else cb(null, chunk);
        },
      });
      const part = path.join(this.dir(this.roots.byId(rec.root)), `${id}.part`);
      // `r+` writes in place at `start` without truncating what follows, so a
      // resent middle chunk leaves the rest of the file alone.
      await pipeline(body, limit, createWriteStream(part, { flags: "r+", start: at }));

      rec.received = Math.max(rec.received, at + written);
      rec.updated = Date.now();
      await this.save(rec);
      return view(rec);
    });
  }

  /** Move the finished file into place. Repeating it answers the same. */
  finish(id: string): Promise<FileEntry> {
    return this.serial(id, async () => {
      const rec = await this.load(id);
      if (rec.done && rec.entry) return rec.entry;
      if (rec.received !== rec.size) {
        throw new FilesError(409, `only ${rec.received} of ${rec.size} bytes have arrived`, `offset:${rec.received}`);
      }
      const root = this.roots.byId(rec.root);
      const part = path.join(this.dir(root), `${id}.part`);
      // A resend that overlapped the end may have left bytes past the size.
      const fh = await fsp.open(part, "r+");
      try {
        await fh.truncate(rec.size);
        await fh.sync();
      } finally {
        await fh.close();
      }

      const dest = await this.roots.creatable(rec.path);
      this.roots.assertMutable(dest);
      await this.checkDestination(dest.fs, dest.abs, rec.overwrite);
      await this.roots.ensureParent(dest);
      try {
        if (rec.overwrite) await fsp.rename(part, fsPath(dest.fs));
        else await noClobberRename(part, dest.fs);
      } catch (err) {
        throw fsError(err, dest.abs);
      }
      const entry = await describe(dest.abs, dest.fs, await this.roots.realRoot(dest.root));
      rec.done = true;
      rec.entry = entry;
      rec.updated = Date.now();
      await this.save(rec);
      return entry;
    });
  }

  /** Abandon an upload and its data. */
  cancel(id: string): Promise<void> {
    return this.serial(id, async () => {
      const rec = await this.load(id);
      const dir = this.dir(this.roots.byId(rec.root));
      await fsp.rm(path.join(dir, `${id}.part`), { force: true });
      await fsp.rm(path.join(dir, `${id}.json`), { force: true });
    });
  }

  /**
   * Remove uploads (finished or not) untouched for longer than the TTL, plus
   * any scratch file left behind by an interrupted copy or move.
   */
  async sweep(now = Date.now()): Promise<number> {
    const ttl = this.opts.ttlMs ?? UPLOAD_TTL_MS;
    let removed = 0;
    for (const root of this.roots.list()) {
      const dir = this.dir(root);
      let names: string[];
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const file = path.join(dir, name);
        const st = await fsp.lstat(file).catch(() => null);
        if (!st || now - st.mtimeMs < ttl) continue;
        const m = /^([0-9a-f]{32})\.(json|part)$/.exec(name);
        if (m && name.endsWith(".json")) {
          // Judge a session by its own clock, not the file's.
          const rec = await this.load(m[1]!).catch(() => null);
          if (rec && now - rec.updated < ttl) continue;
        }
        await removeTree(file).catch(() => {});
        removed += 1;
      }
    }
    return removed;
  }

  /** Sweep now and then every hour, until the returned stop is called. */
  startSweeping(everyMs = 60 * 60 * 1000): () => void {
    void this.sweep().catch(() => {});
    const timer = setInterval(() => void this.sweep().catch(() => {}), everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

function view(rec: Record): UploadSession {
  return {
    id: rec.id,
    path: rec.path,
    size: rec.size,
    received: rec.received,
    overwrite: rec.overwrite,
    created: rec.created,
    updated: rec.updated,
    done: rec.done,
  };
}
