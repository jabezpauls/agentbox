import { join } from "./paths.ts";

/**
 * What was dropped on Files, or picked with an upload button, as a flat list
 * of files with where each goes, plus any empty folders (a folder with files
 * in it is made by its files' uploads; an empty one would otherwise vanish).
 *
 * A dropped folder is only reachable through `webkitGetAsEntry()` — the
 * DataTransfer's own `files` list names the folder but not what is in it —
 * and a directory reader hands its entries over in batches until it returns
 * an empty one.
 */
export interface Collected {
  files: { file: File; dest: string }[];
  emptyDirs: string[];
}

/** The parts of the entry API used here (FileSystemEntry and friends). */
interface Entry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}
interface FileEntryLike extends Entry {
  file(ok: (f: File) => void, fail: (e: unknown) => void): void;
}
interface DirEntryLike extends Entry {
  createReader(): { readEntries(ok: (entries: Entry[]) => void, fail: (e: unknown) => void): void };
}

function fileOf(entry: FileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readAll(dir: DirEntryLike): Promise<Entry[]> {
  const reader = dir.createReader();
  const out: Entry[] = [];
  for (;;) {
    const batch = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

async function walk(entry: Entry, dest: string, into: Collected): Promise<void> {
  if (entry.isFile) {
    into.files.push({ file: await fileOf(entry as FileEntryLike), dest });
    return;
  }
  if (!entry.isDirectory) return;
  const children = await readAll(entry as DirEntryLike);
  if (children.length === 0) {
    into.emptyDirs.push(dest);
    return;
  }
  for (const child of children) await walk(child, join(dest, child.name), into);
}

/** True when a drag carries files from outside the page (not rows dragged within it). */
export function carriesFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes("Files");
}

/**
 * Everything dropped, into `dir`. The entries must be taken synchronously in
 * the drop handler — the DataTransfer is emptied once it returns — so call
 * this straight from `onDrop`.
 */
export function collectDrop(dt: DataTransfer, dir: string): Promise<Collected> {
  const entries: Entry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const entry = (item as DataTransferItem & { webkitGetAsEntry?(): Entry | null }).webkitGetAsEntry?.() ?? null;
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) loose.push(f);
    }
  }
  return (async () => {
    const out: Collected = { files: loose.map((file) => ({ file, dest: join(dir, file.name) })), emptyDirs: [] };
    for (const e of entries) await walk(e, join(dir, e.name), out);
    return out;
  })();
}

/** Files from an `<input type=file>`, keeping a picked folder's structure (`webkitRelativePath`). */
export function collectPicked(list: FileList | File[], dir: string): Collected {
  const files = Array.from(list).map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    return { file, dest: rel.split("/").filter(Boolean).reduce((d, name) => join(d, name), dir) };
  });
  return { files, emptyDirs: [] };
}
