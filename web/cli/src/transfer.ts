import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { sleep as defaultSleep } from "./device.js";
import { ApiError, CliError, EXIT } from "./errors.js";
import { MAX_CHUNK, type FilesApi } from "./files-api.js";
import type { OutStream } from "./context.js";
import type { FileEntry, UploadSession } from "@workbench/shared";

/**
 * Moving file contents: chunked, resumable uploads and streamed downloads.
 *
 * An upload is the files API's three steps — start, chunks at offsets,
 * finish — each safe to repeat. A chunk that fails on the network, or with a
 * 5xx, is not guessed about: the CLI asks the box how much arrived and goes on
 * from there. The upload's id is remembered on this machine until it
 * finishes, so running the same `files put` again after Ctrl-C, a dropped
 * connection or a closed laptop picks up where the box left off rather than
 * starting over (the box keeps an untouched upload for a day).
 */

/** Uploads this machine can resume, keyed by what is being sent where. */
export class ResumeStore {
  readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "uploads.json");
  }

  static key(parts: { box: string; local: string; remote: string; size: number; mtimeMs: number }): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  }

  private read(): Record<string, { id: string; at: number; remote: string }> {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, { id: string; at: number; remote: string }>;
      const fresh: typeof data = {};
      // The box sweeps an upload untouched for a day; so does this.
      for (const [k, v] of Object.entries(data)) if (v && typeof v.id === "string" && Date.now() - v.at < 24 * 3600_000) fresh[k] = v;
      return fresh;
    } catch {
      return {};
    }
  }

  private write(data: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // Only resuming is lost.
    }
  }

  get(key: string): string | null {
    return this.read()[key]?.id ?? null;
  }

  set(key: string, id: string, remote: string): void {
    const data = this.read();
    data[key] = { id, at: Date.now(), remote };
    this.write(data);
  }

  delete(key: string): void {
    const data = this.read();
    if (!(key in data)) return;
    delete data[key];
    this.write(data);
  }
}

export interface UploadOptions {
  api: FilesApi;
  /** Local file. */
  file: string;
  /** Destination on the box, the file's own path. */
  remote: string;
  overwrite: boolean;
  chunkSize?: number;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
  resume?: ResumeStore | null;
  /** Failed attempts in a row before giving up. */
  retries?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Told when an upload picks up where an earlier run left off. */
  onResume?: (received: number, total: number) => void;
}

/** A failure worth another try: the network, or the box between restarts. */
function transient(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500 && err.status !== 507;
  return err instanceof CliError && err.exitCode === EXIT.UNREACHABLE;
}

/** The offset the box asked for, from a `409 {code: "offset:N"}`. */
export function resumeOffset(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 409 || !err.code) return null;
  const m = /^offset:(\d+)$/.exec(err.code);
  return m ? Number(m[1]) : null;
}

/** A pass-through that counts what goes by. */
function counter(onBytes: (n: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
}

export async function uploadFile(opts: UploadOptions): Promise<FileEntry> {
  const { api } = opts;
  const wait = opts.sleep ?? defaultSleep;
  const maxRetries = opts.retries ?? 5;
  let chunkSize = Math.min(opts.chunkSize ?? MAX_CHUNK, MAX_CHUNK);
  const st = await fs.promises.stat(opts.file);
  if (!st.isFile()) throw new CliError(`${opts.file} is not a file`);
  const size = st.size;
  const key = ResumeStore.key({ box: api.client.origin, local: path.resolve(opts.file), remote: opts.remote, size, mtimeMs: st.mtimeMs });

  let session: UploadSession | null = null;
  const known = opts.resume?.get(key) ?? null;
  if (known) {
    try {
      const s = await api.getUpload(known);
      if (!s.done && s.size === size && s.overwrite === opts.overwrite) {
        session = s;
        if (s.received > 0) opts.onResume?.(s.received, size);
      } else if (!s.done) {
        // Asked for differently this time (--force added, say): let it go.
        await api.cancelUpload(known).catch(() => {});
      }
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // Swept, or finished and forgotten: start afresh.
    }
    if (!session) opts.resume?.delete(key);
  }
  if (!session) {
    const started = await api.startUpload(opts.remote, size, opts.overwrite);
    session = { ...started, id: started.uploadId ?? started.id };
    opts.resume?.set(key, session.id, opts.remote);
  }
  const id = session.id;
  let offset = session.received;
  let failures = 0;
  opts.onProgress?.(offset, size);

  /** After a failure: how much the box really has. */
  const recover = async (err: unknown): Promise<void> => {
    const asked = resumeOffset(err);
    if (asked !== null) {
      offset = asked;
      return;
    }
    if (err instanceof ApiError && err.status === 413 && chunkSize > 1024 * 1024) {
      // Something between here and the box takes less than the API does.
      chunkSize = Math.max(1024 * 1024, Math.floor(chunkSize / 2));
      return;
    }
    if (err instanceof ApiError && err.status === 404) {
      opts.resume?.delete(key);
      throw new CliError(`the box no longer has this upload (it was cancelled, or untouched for a day); run the command again to start over`);
    }
    if (!transient(err) || ++failures > maxRetries) throw err;
    await wait(Math.min(30_000, 1000 * 2 ** (failures - 1)), opts.signal);
    try {
      offset = (await api.getUpload(id)).received;
    } catch (e) {
      if (!transient(e)) throw e;
      // Still unreachable: the next attempt at the same offset will say.
    }
  };

  for (;;) {
    while (offset < size) {
      const length = Math.min(chunkSize, size - offset);
      const at = offset;
      let sent = 0;
      const body = fs.createReadStream(opts.file, { start: at, end: at + length - 1 }).pipe(
        counter((n) => {
          sent += n;
          opts.onProgress?.(at + sent, size);
        }),
      );
      try {
        const s = await api.putChunk(id, at, body, length, opts.signal);
        offset = s.received;
        failures = 0;
      } catch (err) {
        body.destroy();
        if (err instanceof CliError && err.exitCode === EXIT.INTERRUPTED) throw err;
        await recover(err);
      }
      opts.onProgress?.(offset, size);
    }
    try {
      const entry = await api.finishUpload(id);
      opts.resume?.delete(key);
      return entry;
    } catch (err) {
      if (err instanceof CliError && err.exitCode === EXIT.INTERRUPTED) throw err;
      await recover(err);
    }
  }
}

export interface DownloadOptions {
  api: FilesApi;
  remote: string;
  /** Local file to write, replaced atomically when complete. */
  local: string;
  onProgress?: (received: number, total: number | null) => void;
  signal?: AbortSignal;
}

/** Download one file to `local`, via a temporary file beside it. Resolves with its size. */
export async function downloadFile(opts: DownloadOptions): Promise<number> {
  const res = await opts.api.raw(opts.remote, opts.signal);
  const declared = Number(res.headers["content-length"]);
  const total = Number.isFinite(declared) ? declared : null;
  const tmp = path.join(path.dirname(opts.local), `.${path.basename(opts.local)}.agentbox-${randomBytes(4).toString("hex")}`);
  let received = 0;
  try {
    const out = fs.createWriteStream(tmp, { flags: "wx" });
    await new Promise<void>((resolve, reject) => {
      res.stream.on("data", (c: Buffer) => {
        received += c.length;
        opts.onProgress?.(received, total);
      });
      res.stream.on("error", reject);
      res.stream.on("aborted", () => reject(new CliError("the download was cut off", EXIT.UNREACHABLE)));
      out.on("error", reject);
      out.on("finish", () => resolve());
      res.stream.pipe(out);
    });
    if (total !== null && received !== total) throw new CliError(`the download was cut off (${received} of ${total} bytes)`, EXIT.UNREACHABLE);
    await fs.promises.rename(tmp, opts.local);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
  return received;
}

/** Copy a download to a stream (stdout), respecting its pace. */
export async function streamTo(api: FilesApi, remote: string, out: OutStream, signal?: AbortSignal): Promise<number> {
  const res = await api.raw(remote, signal);
  let n = 0;
  for await (const chunk of res.stream) {
    n += (chunk as Buffer).length;
    if (!out.write(chunk as Buffer)) await new Promise<void>((r) => (out.once ? out.once("drain", () => r()) : r()));
  }
  return n;
}
