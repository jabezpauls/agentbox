import { createReadStream } from "node:fs";
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

export interface ZipSource {
  /** The real path to read. */
  fs: string;
  /** The top-level name inside the archive. */
  name: string;
}

/**
 * Stream a zip of `sources` into the returned readable. Entries are added as
 * the walk finds them, so the download starts at once and memory stays flat
 * however large the tree is.
 *
 * Symlinks are left out rather than followed — a link out of the root, or a
 * loop, must not become part of the archive. Names that are not valid UTF-8
 * are written with U+FFFD in place of the stray bytes (the format flags every
 * name as UTF-8), which is lossy only for the name, never the content.
 */
export function zipStream(
  sources: ZipSource[],
  onError: (err: unknown) => void,
  /** Real paths left out wherever they turn up — the roots' own state. */
  exclude: ReadonlySet<string> = new Set(),
): NodeJS.ReadableStream {
  const zip = new yazl.ZipFile();
  const used = new Set<string>();
  const fail = (err: unknown): void => {
    onError(err);
    (zip.outputStream as Readable).destroy(err instanceof Error ? err : new Error(String(err)));
  };
  // A file that vanished or changed size mid-read is reported here, on the
  // archive rather than its output; the download is cut short either way.
  zip.on("error", fail);

  // yazl reads a backslash as a separator; in a Linux name it is a character.
  const entryName = (name: string): string => displayName(name).replace(/\\/g, "_");

  const unique = (name: string): string => {
    let candidate = name;
    for (let n = 2; used.has(candidate); n++) {
      const ext = path.extname(name);
      candidate = `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
    }
    used.add(candidate);
    return candidate;
  };

  const walk = async (fs: string, name: string): Promise<void> => {
    const st = await fsp.lstat(fsPath(fs));
    const meta = { mtime: st.mtime, mode: st.mode };
    if (st.isDirectory()) {
      zip.addEmptyDirectory(name, meta);
      const names = await fsp.readdir(fsPath(fs), { encoding: "buffer" });
      for (const raw of names) {
        const child = decodeName(raw);
        if (exclude.has(path.join(fs, child))) continue;
        await walk(path.join(fs, child), `${name}/${entryName(child)}`);
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
    }
  };

  void (async () => {
    for (const s of sources) await walk(s.fs, unique(entryName(s.name)));
    zip.end();
  })().catch(fail);

  return zip.outputStream;
}
