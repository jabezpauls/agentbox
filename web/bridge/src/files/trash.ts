import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FileEntry, TrashItem } from "@workbench/shared";
import { describe, typeOf } from "./entries.js";
import { fsPath } from "./names.js";
import { fsError, FilesError, type Root, type Roots } from "./roots.js";
import { moveTree, noClobberRename, removeTree } from "./tree.js";

export const TRASH_ID = /^[0-9a-f]{24}$/;

/** What `trash()` did with each path it was given. */
export interface TrashResult {
  trashed: TrashItem[];
  /** Paths that were already gone — the second click of a double click. */
  missing: string[];
}

interface Meta extends TrashItem {
  v: 1;
}

/**
 * The trash: deleted things are moved, not destroyed, and permanent deletion
 * happens only from here.
 *
 * Each root keeps its own trash (`<root>/.agentbox/trash`), on the same volume
 * as what it holds, so trashing is a rename and never a copy across devices.
 * An item is a directory named by its id holding `meta.json` (where it came
 * from, when) and `item` (the thing itself). The metadata is written before
 * the item is moved in, so a crash between the two leaves an entry that lists
 * as empty rather than an item nobody can find.
 */
export class Trash {
  constructor(private readonly roots: Roots) {}

  private dir(root: Root): string {
    return path.join(this.roots.stateDir(root), "trash");
  }

  async trash(paths: unknown): Promise<TrashResult> {
    if (!Array.isArray(paths) || paths.length === 0) throw new FilesError(400, "paths required");
    const result: TrashResult = { trashed: [], missing: [] };
    for (const p of paths) {
      const loc = this.roots.locate(p);
      this.roots.assertMutable(loc);
      let ref;
      try {
        ref = await this.roots.entry(p);
      } catch (err) {
        if (err instanceof FilesError && err.status === 404) {
          result.missing.push(loc.abs);
          continue;
        }
        throw err;
      }
      result.trashed.push(await this.put(ref.root, ref.abs, ref.fs));
    }
    return result;
  }

  /** Move the entry at real path `fs` (reported as `abs`) into `root`'s trash. */
  async put(root: Root, abs: string, fs: string): Promise<TrashItem> {
    const st = await fsp.lstat(fsPath(fs)).catch((err: unknown) => {
      throw fsError(err, abs);
    });
    const id = randomBytes(12).toString("hex");
    const home = path.join(this.dir(root), id);
    const type = typeOf(st);
    const meta: Meta = {
      v: 1,
      id,
      name: path.basename(abs),
      originalPath: abs,
      root: root.id,
      type,
      size: type === "file" ? st.size : null,
      trashedAt: Date.now(),
    };
    await fsp.mkdir(home, { recursive: true });
    await writeJson(path.join(home, "meta.json"), meta);
    try {
      await moveTree(fs, path.join(home, "item"), home);
    } catch (err) {
      await removeTree(home).catch(() => {});
      throw fsError(err, abs);
    }
    return view(meta);
  }

  /** Everything in every root's trash, most recent first. */
  async list(): Promise<TrashItem[]> {
    const items: TrashItem[] = [];
    for (const root of this.roots.list()) {
      let ids: string[];
      try {
        ids = await fsp.readdir(this.dir(root));
      } catch {
        continue;
      }
      for (const id of ids) {
        if (!TRASH_ID.test(id)) continue;
        const meta = await this.read(root, id);
        if (meta) items.push(view(meta));
      }
    }
    return items.sort((a, b) => b.trashedAt - a.trashedAt);
  }

  private async read(root: Root, id: string): Promise<Meta | null> {
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(this.dir(root), id, "meta.json"), "utf8")) as Meta;
      return parsed && parsed.id === id ? parsed : null;
    } catch {
      return null;
    }
  }

  private async find(id: string): Promise<{ root: Root; meta: Meta }> {
    if (!TRASH_ID.test(id)) throw new FilesError(400, "invalid trash id");
    for (const root of this.roots.list()) {
      const meta = await this.read(root, id);
      if (meta) return { root, meta };
    }
    throw new FilesError(404, "no such item in the trash", "not-found");
  }

  /**
   * Put an item back where it came from, or at `to`. The destination must not
   * exist; missing parent directories are recreated.
   */
  async restore(id: string, to?: unknown): Promise<FileEntry> {
    const { root, meta } = await this.find(id);
    const home = path.join(this.dir(root), id);
    const dest = await this.roots.creatable(to === undefined ? meta.originalPath : to);
    this.roots.assertMutable(dest);
    try {
      await fsp.lstat(fsPath(path.join(home, "item")));
    } catch {
      // Metadata without an item: the entry was half-written. Clear it.
      await removeTree(home);
      throw new FilesError(410, "the trashed item is gone", "gone");
    }
    await this.roots.ensureParent(dest);
    try {
      await fsp.lstat(fsPath(dest.fs));
      throw new FilesError(409, `${dest.abs} already exists`, "exists");
    } catch (err) {
      if (err instanceof FilesError) throw err;
    }
    try {
      if (dest.root.id === root.id) await noClobberRename(path.join(home, "item"), dest.fs);
      else await moveTree(path.join(home, "item"), dest.fs, path.join(this.roots.stateDir(dest.root), "uploads"));
    } catch (err) {
      throw fsError(err, dest.abs);
    }
    await removeTree(home);
    return describe(dest.abs, dest.fs, await this.roots.realRoot(dest.root));
  }

  /** Delete an item for good. */
  async remove(id: string): Promise<void> {
    const { root } = await this.find(id);
    await removeTree(path.join(this.dir(root), id));
  }

  /** Delete everything in the trash for good; returns how many items went. */
  async empty(): Promise<number> {
    const items = await this.list();
    for (const item of items) await this.remove(item.id).catch(() => {});
    return items.length;
  }
}

function view(meta: Meta): TrashItem {
  return {
    id: meta.id,
    name: meta.name,
    originalPath: meta.originalPath,
    root: meta.root,
    type: meta.type,
    size: meta.size,
    trashedAt: meta.trashedAt,
  };
}

/** Write JSON atomically: a temp file beside it, then a rename. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value));
  await fsp.rename(tmp, file);
}
