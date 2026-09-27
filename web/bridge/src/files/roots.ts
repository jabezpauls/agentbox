import fsp from "node:fs/promises";
import path from "node:path";
import type { FileRoot } from "@workbench/shared";
import { decodeName, encodeName, fsPath, hasEscapes, NameError } from "./names.js";

/**
 * A failure the files API reports to its caller as-is: a status and a
 * sentence. Everything else that escapes a handler is a 500.
 */
export class FilesError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "FilesError";
  }
}

export interface Root {
  id: FileRoot;
  /** The configured path, lexically normal. Paths are reported under it. */
  path: string;
}

/** A client path placed inside a root, before touching the filesystem. */
export interface Located {
  root: Root;
  /** Absolute and lexically normal, e.g. `/workspace/app/src`. */
  abs: string;
}

/** An existing entry, addressed without following its final component. */
export interface EntryRef extends Located {
  /** Where to operate: the real parent directory plus the entry's own name. */
  fs: string;
}

/** An existing entry resolved through every symlink, still inside its root. */
export interface TargetRef extends Located {
  /** The fully resolved path. */
  real: string;
}

/** A path that does not exist yet (or is to be replaced), ready to create. */
export interface NewRef extends Located {
  /** The real parent directory plus the new name. */
  fs: string;
}

const MAX_PATH = 4096;

/**
 * The directory under each root where the files API keeps its own state: the
 * trash, upload scratch space and clones in progress. It lives on the root's
 * own volume so moving into and out of it is always a rename, never a copy.
 */
export const STATE_DIR = ".agentbox";
const RESERVED = ["trash", "uploads", "clones"];

/** True when `child` is `parent` or beneath it. */
export function within(child: string, parent: string): boolean {
  if (child === parent) return true;
  const base = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(base);
}

/**
 * Confinement for every path the files API touches.
 *
 * A path is first placed lexically — `..` collapses, a relative path hangs off
 * the workspace, `~` means home — and must land inside a root. It is then
 * resolved on disk with `realpath`, and the result must still be inside the
 * same root's real path, so no symlink leads out. What "resolved" means depends
 * on the operation:
 *
 *  - reading through a path ({@link target}) follows every link, and the final
 *    destination must be inside the root;
 *  - acting on an entry itself — renaming, trashing a symlink rather than what
 *    it points at ({@link entry}) — resolves only the parent;
 *  - creating something ({@link creatable}) resolves the nearest existing
 *    ancestor, so a write can never be carried out of the root by a link on
 *    the way to it.
 *
 * The bridge runs as the same user as every agent, so this is not a defence
 * against the sandbox. It is what makes the API mean what it says: nothing a
 * caller names, however it is spelled, reaches outside the two roots.
 */
export class Roots {
  readonly workspace: Root;
  readonly home: Root;
  private readonly all: Root[];
  private readonly realCache = new Map<string, string>();

  constructor(workspacePath: string, homePath: string) {
    this.workspace = { id: "workspace", path: path.resolve(workspacePath) };
    this.home = { id: "home", path: path.resolve(homePath) };
    // Longest first, so a nested root (possible in tests) wins over its parent.
    this.all = [this.workspace, this.home].sort((a, b) => b.path.length - a.path.length);
  }

  byId(id: FileRoot): Root {
    return id === "home" ? this.home : this.workspace;
  }

  list(): Root[] {
    return [this.workspace, this.home];
  }

  /** The root's own real path, resolved once. */
  async realRoot(root: Root): Promise<string> {
    const cached = this.realCache.get(root.path);
    if (cached) return cached;
    let real: string;
    try {
      real = await fsp.realpath(root.path);
    } catch {
      throw new FilesError(404, `${root.path} does not exist`);
    }
    this.realCache.set(root.path, real);
    return real;
  }

  /** The state directory of a root, e.g. `/workspace/.agentbox`. */
  stateDir(root: Root): string {
    return path.join(root.path, STATE_DIR);
  }

  /** Place a client path lexically. Throws for anything outside every root. */
  locate(input: unknown): Located {
    if (typeof input !== "string") throw new FilesError(400, "path required");
    if (input.length > MAX_PATH) throw new FilesError(400, "path too long");
    if (input.includes("\0")) throw new FilesError(400, "path contains a NUL byte");
    if (hasEscapes(input)) {
      try {
        encodeName(input);
      } catch (err) {
        if (err instanceof NameError) throw new FilesError(400, err.message);
        throw err;
      }
    }
    let abs: string;
    if (input === "~" || input.startsWith("~/")) abs = path.resolve(this.home.path, "." + input.slice(1));
    else abs = path.resolve(this.workspace.path, input === "" ? "." : input);
    const root = this.all.find((r) => within(abs, r.path));
    if (!root) throw new FilesError(403, `${input} is outside the workspace and home`, "outside");
    return { root, abs };
  }

  /** True when `abs` is the root itself or inside its reserved state dirs. */
  isReserved(loc: Located): boolean {
    if (loc.abs === loc.root.path) return true;
    const state = this.stateDir(loc.root);
    if (loc.abs === state) return true;
    return RESERVED.some((d) => within(loc.abs, path.join(state, d)));
  }

  /** Refuse to change the root itself or the API's own state. */
  assertMutable(loc: Located): void {
    if (loc.abs === loc.root.path) throw new FilesError(403, "the root itself cannot be changed", "reserved");
    if (this.isReserved(loc)) {
      throw new FilesError(403, `${loc.abs} holds agentbox's own state`, "reserved");
    }
  }

  /**
   * Refuse to copy or move anything that is, holds, or sits inside a root's
   * `.agentbox`. Carrying the trash and upload scratch along is never what a
   * person meant — and a copy is built inside that very scratch space, so a
   * copy of it would copy itself until the disk filled. Checked on the path
   * as named and as resolved, since a link can lead there.
   */
  async assertMovable(ref: EntryRef): Promise<void> {
    for (const root of this.all) {
      const lexical = this.stateDir(root);
      const real = await this.realRoot(root).then(
        (r) => path.join(r, STATE_DIR),
        () => null,
      );
      for (const [p, state] of [
        [ref.abs, lexical],
        [ref.fs, real],
      ] as const) {
        if (state && (within(p, state) || within(state, p))) {
          throw new FilesError(403, `${ref.abs} holds agentbox's own state`, "reserved");
        }
      }
    }
  }

  /** Resolve through every symlink; the destination must stay in the root. */
  async target(input: unknown): Promise<TargetRef> {
    const loc = this.locate(input);
    const rootReal = await this.realRoot(loc.root);
    let real: string;
    try {
      real = decodeName(await fsp.realpath(fsPath(loc.abs), { encoding: "buffer" }));
    } catch (err) {
      throw fsError(err, loc.abs);
    }
    if (!within(real, rootReal)) {
      throw new FilesError(403, `${loc.abs} leads outside its root`, "outside");
    }
    return { ...loc, real };
  }

  /**
   * Address an existing entry itself (a symlink, not what it points at). The
   * parent is resolved and confined; the entry must exist.
   */
  async entry(input: unknown): Promise<EntryRef> {
    const loc = this.locate(input);
    if (loc.abs === loc.root.path) {
      return { ...loc, fs: await this.realRoot(loc.root) };
    }
    const parent = await this.realParent(loc);
    const fsp_ = path.join(parent, path.basename(loc.abs));
    try {
      await fsp.lstat(fsPath(fsp_));
    } catch (err) {
      throw fsError(err, loc.abs);
    }
    return { ...loc, fs: fsp_ };
  }

  /**
   * Address a path to create. The nearest existing ancestor is resolved and
   * confined; missing directories in between are not created here (see
   * {@link ensureParent}). Whether the final name exists is the caller's call.
   */
  async creatable(input: unknown): Promise<NewRef> {
    const loc = this.locate(input);
    if (loc.abs === loc.root.path) throw new FilesError(409, "the root already exists", "exists");
    const rootReal = await this.realRoot(loc.root);
    // Walk up to the deepest ancestor that exists and resolve it.
    const missing: string[] = [path.basename(loc.abs)];
    let dir = path.dirname(loc.abs);
    for (;;) {
      try {
        const real = decodeName(await fsp.realpath(fsPath(dir), { encoding: "buffer" }));
        if (!within(real, rootReal)) throw new FilesError(403, `${loc.abs} leads outside its root`, "outside");
        const st = await fsp.stat(fsPath(real));
        if (!st.isDirectory()) throw new FilesError(409, `${dir} is not a directory`, "not-a-directory");
        return { ...loc, fs: path.join(real, ...missing.reverse()) };
      } catch (err) {
        if (err instanceof FilesError) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" || dir === loc.root.path) throw fsError(err, dir);
        missing.push(path.basename(dir));
        dir = path.dirname(dir);
      }
    }
  }

  /**
   * Create the missing directories between a {@link creatable} path's real
   * ancestor and its parent. Each is created (never followed) in turn, so a
   * link planted on the way cannot divert the write.
   */
  async ensureParent(ref: NewRef): Promise<void> {
    const parent = path.dirname(ref.fs);
    const rootReal = await this.realRoot(ref.root);
    const parts: string[] = [];
    let dir = parent;
    for (;;) {
      try {
        const st = await fsp.lstat(fsPath(dir));
        if (st.isDirectory()) break;
        throw new FilesError(409, `${dir} is not a directory`, "not-a-directory");
      } catch (err) {
        if (err instanceof FilesError) throw err;
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw fsError(err, dir);
        parts.push(dir);
        dir = path.dirname(dir);
      }
    }
    if (!within(dir, rootReal)) throw new FilesError(403, `${ref.abs} leads outside its root`, "outside");
    for (const d of parts.reverse()) {
      try {
        await fsp.mkdir(fsPath(d));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw fsError(err, d);
        const st = await fsp.lstat(fsPath(d));
        if (!st.isDirectory()) throw new FilesError(409, `${d} is not a directory`, "not-a-directory");
      }
    }
  }

  private async realParent(loc: Located): Promise<string> {
    const rootReal = await this.realRoot(loc.root);
    const dir = path.dirname(loc.abs);
    let real: string;
    try {
      real = decodeName(await fsp.realpath(fsPath(dir), { encoding: "buffer" }));
    } catch (err) {
      throw fsError(err, loc.abs);
    }
    if (!within(real, rootReal)) throw new FilesError(403, `${loc.abs} leads outside its root`, "outside");
    return real;
  }

  /** The lexical path a real path inside a root is reported as. */
  present(root: Root, rootReal: string, real: string): string {
    if (real === rootReal) return root.path;
    return path.join(root.path, real.slice(rootReal.length + 1));
  }
}

/** Translate a filesystem error into what the API reports. */
export function fsError(err: unknown, where: string): Error {
  if (err instanceof FilesError) return err;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ENOENT":
      return new FilesError(404, `${where} does not exist`, "not-found");
    case "EEXIST":
    case "ENOTEMPTY":
      return new FilesError(409, `${where} already exists`, "exists");
    case "ENOTDIR":
      return new FilesError(409, `a parent of ${where} is not a directory`, "not-a-directory");
    case "EISDIR":
      return new FilesError(409, `${where} is a directory`, "is-a-directory");
    case "ELOOP":
      return new FilesError(400, `${where} is a symlink loop`, "loop");
    case "EACCES":
    case "EPERM":
      return new FilesError(403, `permission denied: ${where}`, "denied");
    case "ENAMETOOLONG":
      return new FilesError(400, `name too long: ${where}`, "too-long");
    case "ENOSPC":
    case "EDQUOT":
      return new FilesError(507, "no space left on the volume", "no-space");
    case "EINVAL":
      return new FilesError(400, `invalid operation on ${where}`, "invalid");
    default:
      return err instanceof Error ? err : new Error(String(err));
  }
}
