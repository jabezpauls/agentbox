import fsp from "node:fs/promises";
import path from "node:path";
import type { FileEntry } from "@workbench/shared";
import { describe } from "./entries.js";
import { fsPath } from "./names.js";
import { fsError, FilesError, within, type NewRef, type Roots } from "./roots.js";
import type { Trash } from "./trash.js";
import { copyTree, moveTree, noClobberRename, removeTree, scratchName } from "./tree.js";

/** The largest text `write` accepts: it is for small files typed in the app. */
export const MAX_WRITE = 1024 * 1024;

/**
 * The mutating file operations other than uploads and the trash. Each is safe
 * to repeat: `mkdir` of an existing directory succeeds, and a repeated move or
 * copy finds its destination taken and refuses without touching anything.
 * `overwrite` never destroys: what it replaces goes to the trash first.
 */
export class FileOps {
  constructor(
    private readonly roots: Roots,
    private readonly trash: Trash,
  ) {}

  private scratch(ref: NewRef): string {
    return path.join(this.roots.stateDir(ref.root), "uploads");
  }

  private async realRoot(ref: NewRef): Promise<string> {
    return this.roots.realRoot(ref.root);
  }

  /** Write a small text file: new by default, replaced with `overwrite`. */
  async write(body: { path?: unknown; content?: unknown; overwrite?: unknown }): Promise<FileEntry> {
    if (typeof body.content !== "string") throw new FilesError(400, "content must be text");
    const data = Buffer.from(body.content, "utf8");
    if (data.length > MAX_WRITE) throw new FilesError(413, `write takes at most ${MAX_WRITE} bytes; upload larger files`);
    const dest = await this.roots.creatable(body.path);
    this.roots.assertMutable(dest);
    await this.roots.ensureParent(dest);
    if (body.overwrite === true) {
      const existing = await fsp.lstat(fsPath(dest.fs)).catch(() => null);
      if (existing?.isDirectory()) throw new FilesError(409, `${dest.abs} is a directory`, "is-a-directory");
      // Replace in one step, so a reader never sees a half-written file.
      const dir = this.scratch(dest);
      await fsp.mkdir(dir, { recursive: true });
      const tmp = scratchName(dir, "write");
      await fsp.writeFile(tmp, data);
      try {
        await fsp.rename(tmp, fsPath(dest.fs));
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        throw fsError(err, dest.abs);
      }
    } else {
      try {
        await fsp.writeFile(fsPath(dest.fs), data, { flag: "wx" });
      } catch (err) {
        throw fsError(err, dest.abs);
      }
    }
    return describe(dest.abs, dest.fs, await this.realRoot(dest));
  }

  /** Make a directory and any missing parents. An existing directory is fine. */
  async mkdir(body: { path?: unknown }): Promise<FileEntry> {
    const dest = await this.roots.creatable(body.path);
    this.roots.assertMutable(dest);
    await this.roots.ensureParent(dest);
    try {
      await fsp.mkdir(fsPath(dest.fs));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw fsError(err, dest.abs);
      const st = await fsp.lstat(fsPath(dest.fs));
      if (!st.isDirectory()) throw new FilesError(409, `${dest.abs} exists and is not a directory`, "exists");
    }
    return describe(dest.abs, dest.fs, await this.realRoot(dest));
  }

  /** Rename or move `from` to `to` — the entry itself, not what a link points at. */
  async move(body: { from?: unknown; to?: unknown; overwrite?: unknown }): Promise<FileEntry> {
    const src = await this.roots.entry(body.from);
    this.roots.assertMutable(src);
    await this.roots.assertMovable(src);
    const dest = await this.roots.creatable(body.to);
    this.roots.assertMutable(dest);
    if (dest.abs === src.abs) return describe(src.abs, src.fs, await this.roots.realRoot(src.root));
    await this.refuseIntoItself(src.fs, dest.fs, src.abs);
    await this.clear(dest, body.overwrite === true);
    await this.roots.ensureParent(dest);
    try {
      if (src.root.id === dest.root.id) await noClobberRename(src.fs, dest.fs);
      else await moveTree(src.fs, dest.fs, this.scratch(dest));
    } catch (err) {
      throw fsError(err, dest.abs);
    }
    return describe(dest.abs, dest.fs, await this.realRoot(dest));
  }

  /**
   * Copy `from` to `to`. A directory is copied whole, symlinks as symlinks.
   * The copy is built under a scratch name and renamed into place, so the
   * destination never shows a half-finished tree.
   */
  async copy(body: { from?: unknown; to?: unknown; overwrite?: unknown }): Promise<FileEntry> {
    const src = await this.roots.entry(body.from);
    await this.roots.assertMovable(src);
    const dest = await this.roots.creatable(body.to);
    this.roots.assertMutable(dest);
    if (dest.abs === src.abs) throw new FilesError(409, "a copy needs a different name", "exists");
    await this.refuseIntoItself(src.fs, dest.fs, src.abs);
    await this.clear(dest, body.overwrite === true);
    await this.roots.ensureParent(dest);
    const dir = this.scratch(dest);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = scratchName(dir, "copy");
    try {
      await copyTree(src.fs, tmp);
      await noClobberRename(tmp, dest.fs);
    } catch (err) {
      await removeTree(tmp).catch(() => {});
      throw fsError(err, dest.abs);
    }
    return describe(dest.abs, dest.fs, await this.realRoot(dest));
  }

  /** A directory cannot be moved or copied into its own subtree. */
  private async refuseIntoItself(srcFs: string, destFs: string, abs: string): Promise<void> {
    const st = await fsp.lstat(fsPath(srcFs));
    if (st.isDirectory() && within(destFs, srcFs)) {
      throw new FilesError(400, `${abs} cannot go inside itself`, "into-itself");
    }
  }

  /** Make way at `dest`: refuse, or with `overwrite` move what is there to the trash. */
  private async clear(dest: NewRef, overwrite: boolean): Promise<void> {
    const st = await fsp.lstat(fsPath(dest.fs)).catch(() => null);
    if (!st) return;
    if (!overwrite) throw new FilesError(409, `${dest.abs} already exists`, "exists");
    await this.trash.put(dest.root, dest.abs, dest.fs);
  }
}
