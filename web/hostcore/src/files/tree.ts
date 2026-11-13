import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { decodeName, fsPath } from "./names.js";

/**
 * Copy `src` to `dst`, which must not exist. Directories are recreated,
 * files copied, and symlinks copied as symlinks — never followed, so a copy
 * cannot loop or pull in anything from outside the tree. Names are handled as
 * bytes throughout: Node's own async `cp` decodes them as UTF-8 and loses any
 * name that is not.
 */
export async function copyTree(src: string, dst: string): Promise<void> {
  const st = await fsp.lstat(fsPath(src));
  if (st.isSymbolicLink()) {
    const link = await fsp.readlink(fsPath(src), { encoding: "buffer" });
    await fsp.symlink(link, fsPath(dst));
  } else if (st.isDirectory()) {
    await fsp.mkdir(fsPath(dst), { mode: st.mode & 0o7777 });
    const names = await fsp.readdir(fsPath(src), { encoding: "buffer" });
    for (const raw of names) {
      const name = decodeName(raw);
      await copyTree(path.join(src, name), path.join(dst, name));
    }
  } else if (st.isFile()) {
    await fsp.copyFile(fsPath(src), fsPath(dst), constants.COPYFILE_EXCL);
  }
  // Sockets, FIFOs and devices are not content; they are left behind.
}

/** Remove a tree without following symlinks out of it. */
export async function removeTree(p: string): Promise<void> {
  await fsp.rm(fsPath(p), { recursive: true, force: true });
}

/** A fresh hidden name for scratch work next to `dir`'s contents. */
export function scratchName(dir: string, label: string): string {
  return path.join(dir, `.${label}-${randomBytes(8).toString("hex")}`);
}

/**
 * Move `src` to `dst` (which must not exist). A rename when both are on one
 * volume; otherwise the tree is copied into a scratch name beside `dst`,
 * renamed into place in one step, and only then removed from `src`, so the
 * destination never shows a half-copied tree.
 */
export async function moveTree(src: string, dst: string, scratchDir: string): Promise<void> {
  try {
    await fsp.rename(fsPath(src), fsPath(dst));
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  await fsp.mkdir(fsPath(scratchDir), { recursive: true });
  const tmp = scratchName(scratchDir, "move");
  try {
    await copyTree(src, tmp);
    await noClobberRename(tmp, dst);
  } catch (err) {
    await removeTree(tmp).catch(() => {});
    throw err;
  }
  await removeTree(src);
}

/**
 * Rename `src` onto `dst` only if `dst` does not exist. A file is linked into
 * place (which fails atomically on an existing name) and then unlinked from
 * its scratch name; a directory is renamed after a check, which is as close as
 * POSIX gets for directories.
 */
export async function noClobberRename(src: string, dst: string): Promise<void> {
  const st = await fsp.lstat(fsPath(src));
  if (st.isFile()) {
    try {
      await fsp.link(fsPath(src), fsPath(dst));
      await fsp.unlink(fsPath(src));
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Filesystems without hard links fall through to check-then-rename.
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EXDEV") throw err;
    }
  }
  try {
    await fsp.lstat(fsPath(dst));
    const err = new Error(`${dst} exists`) as NodeJS.ErrnoException;
    err.code = "EEXIST";
    throw err;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await fsp.rename(fsPath(src), fsPath(dst));
}
