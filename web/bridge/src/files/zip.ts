import { createReadStream, type Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import yazl from "yazl";
import { decodeName, displayName, fsPath } from "./names.js";

/** Formats that are already compressed: storing them saves CPU and nothing else. */
const STORED = new Set([
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z", ".rar",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic",
  ".mp4", ".mov", ".mkv", ".webm", ".mp3", ".m4a", ".ogg", ".flac",
  ".woff", ".woff2", ".pdf", ".jar", ".whl", ".docx", ".xlsx", ".pptx",
]);

/** How far the walk may run ahead of what has been written, in entries. */
const MAX_BACKLOG = 256;

export interface ZipSource {
  /** The real path to read. */
  fs: string;
  /** The top-level name inside the archive. */
  name: string;
}

export interface ZipOptions {
  /** Real paths left out wherever they turn up — the roots' own state. */
  exclude?: ReadonlySet<string>;
  /** Stops the walk: the download was abandoned. */
  signal?: AbortSignal;
}

/**
 * One path component as a zip entry can hold it. The format flags every name
 * as UTF-8, so stray bytes become U+FFFD; yazl reads a backslash as a
 * separator and refuses a name that looks like a drive (`C:notes.txt`), so
 * those characters are replaced. Only the name is ever lossy, never content.
 */
export function entryComponent(name: string): string {
  let n = displayName(name).replace(/\\/g, "_");
  if (/^[A-Za-z]:/.test(n)) n = `${n[0]}_${n.slice(2)}`;
  return n;
}

/**
 * Stream a zip of `sources` into the returned readable. Entries are added as
 * the walk finds them, so the download starts at once, and the walk stays a
 * bounded distance ahead of what has been written, so memory stays flat
 * however large the tree is. When the download is abandoned the walk stops.
 *
 * Symlinks are left out rather than followed — a link out of the root, or a
 * loop, must not become part of the archive. Names made alike by
 * {@link entryComponent} are told apart with a ` (2)` suffix.
 */
export function zipStream(sources: ZipSource[], onError: (err: unknown) => void, opts: ZipOptions = {}): NodeJS.ReadableStream {
  const zip = new yazl.ZipFile();
  const out = zip.outputStream as Readable;
  const exclude = opts.exclude ?? new Set<string>();
  const used = new Set<string>();
  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  opts.signal?.addEventListener(
    "abort",
    () => {
      stop();
      out.destroy();
    },
    { once: true },
  );
  // The response pipeline destroys this stream when the client goes away.
  out.once("close", stop);

  const fail = (err: unknown): void => {
    stopped = true;
    onError(err);
    out.destroy(err instanceof Error ? err : new Error(String(err)));
  };
  // A file that vanished or changed size mid-read is reported here, on the
  // archive rather than its output; the download is cut short either way.
  zip.on("error", fail);

  const unique = (dir: string, component: string, isDir: boolean): string => {
    const ext = isDir ? "" : path.extname(component);
    const stem = component.slice(0, component.length - ext.length);
    let candidate = `${dir}${component}`;
    for (let n = 2; used.has(candidate); n++) candidate = `${dir}${stem} (${n})${ext}`;
    used.add(candidate);
    return candidate;
  };

  // yazl keeps every entry it has been given; the walk waits while too many
  // are still unwritten, which is what a slow download looks like.
  let written = 0;
  const backlog = (): number => {
    const entries = (zip as unknown as { entries?: { state?: number }[] }).entries;
    if (!Array.isArray(entries)) return 0;
    while (written < entries.length && entries[written]!.state === 3 /* FILE_DATA_DONE */) written++;
    return entries.length - written;
  };
  const keepPace = async (): Promise<void> => {
    while (!stopped && backlog() > MAX_BACKLOG) await new Promise((r) => setTimeout(r, 10));
  };

  const walk = async (fs: string, name: string, st: Stats): Promise<void> => {
    if (stopped) return;
    const meta = { mtime: st.mtime, mode: st.mode };
    if (st.isDirectory()) {
      zip.addEmptyDirectory(name, meta);
      const names = await fsp.readdir(fsPath(fs), { encoding: "buffer" });
      for (const raw of names) {
        if (stopped) return;
        const child = decodeName(raw);
        if (exclude.has(path.join(fs, child))) continue;
        const childSt = await fsp.lstat(fsPath(path.join(fs, child))).catch(() => null);
        if (!childSt || (!childSt.isDirectory() && !childSt.isFile())) continue;
        await walk(path.join(fs, child), unique(`${name}/`, entryComponent(child), childSt.isDirectory()), childSt);
      }
    } else if (st.isFile()) {
      zip.addReadStreamLazy(
        name,
        { ...meta, compress: !STORED.has(path.extname(name).toLowerCase()) },
        (cb) => {
          const stream = createReadStream(fsPath(fs));
          stream.once("error", (err) => cb(err, stream));
          stream.once("open", () => cb(null, stream));
        },
      );
      await keepPace();
    }
  };

  void (async () => {
    for (const s of sources) {
      if (stopped) break;
      const st = await fsp.lstat(fsPath(s.fs));
      await walk(s.fs, unique("", entryComponent(s.name), st.isDirectory()), st);
    }
    if (!stopped) zip.end();
  })().catch(fail);

  return out;
}
