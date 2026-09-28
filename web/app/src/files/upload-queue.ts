import { basename, dirname, join, numberedName } from "./paths.ts";

/**
 * Uploads, in chunks, through the files API: start a session, send chunks at
 * offsets, finish — so a big file survives a dropped connection and a
 * Cloudflare-sized request cap (a chunk is at most 50 MiB; we send 8).
 *
 * Every step can fail after the server acted on it, and the API is built so
 * each is safe to repeat. The queue leans on that:
 *  - a chunk that fails on the network is retried with backoff, from the
 *    offset the server says it has (it may have taken the chunk after all);
 *  - a chunk refused as "not there yet" (`offset:N`) resumes at N at once;
 *  - a name that is taken pauses the file as a conflict until you choose
 *    Replace (the old one goes to the trash), Keep both ("name (2).ext") or
 *    Skip.
 */

export type UploadState = "queued" | "uploading" | "finishing" | "done" | "error" | "cancelled" | "conflict" | "skipped";

export interface UploadItem {
  id: string;
  /** The batch this file came in with — one drop, one pick. */
  batch: string;
  name: string;
  /** Where it goes. */
  dest: string;
  size: number;
  /** Bytes the server has, as far as we know. */
  sent: number;
  state: UploadState;
  error?: string | undefined;
}

export interface UploadSource {
  file: Blob;
  dest: string;
}

/** The server's side of an upload. `put` reports bytes of this chunk as they go. */
export interface UploadTransport {
  start(path: string, size: number, overwrite: boolean): Promise<{ uploadId: string }>;
  put(uploadId: string, offset: number, chunk: Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<{ received: number }>;
  status(uploadId: string): Promise<{ received: number }>;
  finish(uploadId: string): Promise<void>;
  cancel(uploadId: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

/** What a transport throws: an HTTP status and the API's reason code, or a network failure (status 0). */
export interface TransportError {
  status: number;
  code?: string | undefined;
  message: string;
}

export function isTransportError(e: unknown): e is TransportError {
  return typeof e === "object" && e !== null && typeof (e as TransportError).status === "number";
}

export type ConflictChoice = "replace" | "rename" | "skip";

interface Options {
  chunkSize?: number;
  concurrency?: number;
  /** Attempts per chunk before the file is marked failed. */
  retries?: number;
  /** How long to wait before retry `n` (1-based). */
  backoff?(n: number): number;
  sleep?(ms: number): Promise<void>;
}

interface Job {
  item: UploadItem;
  file: Blob;
  uploadId: string | null;
  overwrite: boolean;
  /** The name the file was dropped with, before any "(n)" Keep both adds. */
  original: string;
  /** Numbered-name attempt, for Keep both; 1 until it is chosen. */
  rename: number;
  abort: AbortController | null;
}

const DEFAULT_CHUNK = 8 * 1024 * 1024;

let seq = 0;
const nextId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export class UploadQueue {
  private jobs: Job[] = [];
  private running = 0;
  private listeners = new Set<() => void>();
  private completeListeners = new Set<(item: UploadItem) => void>();
  private readonly chunk: number;
  private readonly concurrency: number;
  private readonly retries: number;
  private readonly backoff: (n: number) => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly transport: UploadTransport,
    opts: Options = {},
  ) {
    this.chunk = opts.chunkSize ?? DEFAULT_CHUNK;
    this.concurrency = opts.concurrency ?? 3;
    this.retries = opts.retries ?? 5;
    this.backoff = opts.backoff ?? ((n) => Math.min(8000, 500 * 2 ** (n - 1)));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get items(): UploadItem[] {
    return this.jobs.map((j) => j.item);
  }

  /** Called on every change (progress included). Returns an unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called once per file that lands. */
  onComplete(fn: (item: UploadItem) => void): () => void {
    this.completeListeners.add(fn);
    return () => this.completeListeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Queue files (and empty folders, made first). Returns the batch id. */
  add(files: UploadSource[], emptyDirs: string[] = []): string {
    const batch = nextId("b");
    if (emptyDirs.length) {
      void Promise.all(emptyDirs.map((d) => this.transport.mkdir(d).catch(() => {}))).then(() => {
        for (const d of emptyDirs) {
          for (const fn of this.completeListeners) fn({ id: nextId("d"), batch, name: basename(d), dest: d, size: 0, sent: 0, state: "done" });
        }
      });
    }
    for (const { file, dest } of files) {
      this.jobs.push({
        item: { id: nextId("u"), batch, name: basename(dest), dest, size: file.size, sent: 0, state: "queued" },
        file,
        uploadId: null,
        overwrite: false,
        original: basename(dest),
        rename: 1,
        abort: null,
      });
    }
    this.emit();
    this.pump();
    return batch;
  }

  private update(job: Job, patch: Partial<UploadItem>): void {
    job.item = { ...job.item, ...patch };
    this.emit();
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const job = this.jobs.find((j) => j.item.state === "queued");
      if (!job) return;
      this.running++;
      this.update(job, { state: "uploading", error: undefined });
      void this.run(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      if (!job.uploadId) {
        try {
          job.uploadId = (await this.transport.start(job.item.dest, job.item.size, job.overwrite)).uploadId;
          // Cancelled while the session was being made: it is not wanted.
          if (this.cancelled(job)) {
            void this.transport.cancel(job.uploadId).catch(() => {});
            return;
          }
        } catch (err) {
          if (isTransportError(err) && err.status === 409 && err.code === "exists") {
            if (job.rename > 1) {
              // Keep both: that number is taken too; try the next.
              job.rename++;
              if (job.rename > 50) this.update(job, { state: "error", error: "No free name was found." });
              else this.rename(job, job.rename, "queued");
              return;
            }
            this.update(job, { state: "conflict" });
            return;
          }
          throw err;
        }
      }
      await this.send(job);
      if (this.cancelled(job)) return;
      this.update(job, { state: "finishing" });
      await this.transport.finish(job.uploadId);
      this.update(job, { state: "done", sent: job.item.size });
      for (const fn of this.completeListeners) fn(job.item);
    } catch (err) {
      if (this.cancelled(job)) return;
      const message = isTransportError(err) ? err.message : err instanceof Error ? err.message : String(err);
      this.update(job, { state: "error", error: message });
    }
  }

  private rename(job: Job, n: number, state?: UploadState): void {
    const name = numberedName(job.original, n);
    this.update(job, { name, dest: join(dirname(job.item.dest), name), ...(state ? { state } : {}) });
  }

  private cancelled(job: Job): boolean {
    return job.item.state === "cancelled";
  }

  private async send(job: Job): Promise<void> {
    let offset = job.item.sent;
    let failures = 0;
    while (offset < job.item.size) {
      if (this.cancelled(job)) return;
      const end = Math.min(job.item.size, offset + this.chunk);
      const abort = new AbortController();
      job.abort = abort;
      try {
        const base = offset;
        const res = await this.transport.put(
          job.uploadId!,
          offset,
          job.file.slice(offset, end),
          (loaded) => this.update(job, { sent: Math.min(job.item.size, base + loaded) }),
          abort.signal,
        );
        offset = res.received;
        failures = 0;
        this.update(job, { sent: offset });
      } catch (err) {
        if (this.cancelled(job)) return;
        if (isTransportError(err) && err.status === 409 && err.code?.startsWith("offset:")) {
          // The server has a different amount than we thought: resume there.
          offset = Number(err.code.slice("offset:".length));
          this.update(job, { sent: offset });
          continue;
        }
        const retryable = !isTransportError(err) || err.status === 0 || err.status >= 500 || err.status === 429;
        failures++;
        if (!retryable || failures > this.retries) throw err;
        this.update(job, { error: "Connection interrupted. Retrying…" });
        await this.sleep(this.backoff(failures));
        if (this.cancelled(job)) return;
        try {
          offset = (await this.transport.status(job.uploadId!)).received;
        } catch {
          // Keep our own idea of the offset; the next put corrects it if wrong.
        }
        this.update(job, { sent: offset, error: undefined });
      } finally {
        job.abort = null;
      }
    }
  }

  cancel(id: string): void {
    const job = this.jobs.find((j) => j.item.id === id);
    if (!job || job.item.state === "done" || job.item.state === "cancelled") return;
    this.update(job, { state: "cancelled", error: undefined });
    job.abort?.abort();
    if (job.uploadId) void this.transport.cancel(job.uploadId).catch(() => {});
  }

  cancelAll(): void {
    for (const j of this.jobs) this.cancel(j.item.id);
  }

  retry(id: string): void {
    const job = this.jobs.find((j) => j.item.id === id);
    if (!job || (job.item.state !== "error" && job.item.state !== "cancelled")) return;
    // A cancelled session is gone on the server; start a new one.
    if (job.item.state === "cancelled") {
      job.uploadId = null;
      job.item = { ...job.item, sent: 0 };
    }
    this.update(job, { state: "queued", error: undefined });
    this.pump();
  }

  /** Settle a name conflict for one file. */
  resolve(id: string, choice: ConflictChoice): void {
    const job = this.jobs.find((j) => j.item.id === id);
    if (!job || job.item.state !== "conflict") return;
    if (choice === "skip") {
      this.update(job, { state: "skipped" });
      return;
    }
    if (choice === "replace") job.overwrite = true;
    else {
      job.rename = 2;
      this.rename(job, 2);
    }
    this.update(job, { state: "queued" });
    this.pump();
  }

  resolveAll(choice: ConflictChoice): void {
    for (const j of this.jobs.filter((x) => x.item.state === "conflict")) this.resolve(j.item.id, choice);
  }

  /** Drop finished, skipped and cancelled files from the list. */
  clearFinished(): void {
    this.jobs = this.jobs.filter((j) => !["done", "skipped", "cancelled"].includes(j.item.state));
    this.emit();
  }
}

export interface UploadSummary {
  files: number;
  done: number;
  active: number;
  conflicts: number;
  errors: number;
  bytes: number;
  sent: number;
}

export function summarise(items: UploadItem[]): UploadSummary {
  const live = items.filter((i) => i.state !== "cancelled" && i.state !== "skipped");
  return {
    files: live.length,
    done: live.filter((i) => i.state === "done").length,
    active: live.filter((i) => i.state === "queued" || i.state === "uploading" || i.state === "finishing").length,
    conflicts: live.filter((i) => i.state === "conflict").length,
    errors: live.filter((i) => i.state === "error").length,
    bytes: live.reduce((n, i) => n + i.size, 0),
    sent: live.reduce((n, i) => n + i.sent, 0),
  };
}
