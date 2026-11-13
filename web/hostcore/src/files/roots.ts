import fsp from "node:fs/promises";
import path from "node:path";
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

/** Whether the files API may change anything under a root. */
export type RootMode = "read" | "write";

/** One folder the files API serves, as configured. */
export interface RootConfig {
  /** How listings and the trash name it: `workspace` and `home` in the box. */
  id: string;
  path: string;
  mode: RootMode;
  /**
   * Where the API keeps this root's trash and upload scratch space. Inside the
   * root (the box's `<root>/.agentbox`), moving into and out of it is always a
   * rename, never a copy.
   */
  stateDir: string;
}

export interface RootsOptions {
  /**
   * The roots, the first being where a relative path hangs. `~` means the one
   * whose id is `home`, when there is one.
   */
  roots: RootConfig[];
  /** Compare paths ignoring case, as on Windows and macOS. */
  caseInsensitive?: boolean;
  /** A resolved path that is never shown nor reached: it reads as missing. */
  isHidden?: (realPath: string) => boolean;
  /** A resolved path that may be read but never changed. */
  isWriteDenied?: (realPath: string) => boolean;
  /** A resolved path that holds a hidden one: never copied, so a copy cannot show it. */
  holdsHidden?: (realPath: string) => boolean;
  /**
   * Why a path as the client spelled it is refused before it is placed (a
   * machine on Windows: UNC and device paths, streams, trailing dots), or
   * `null` to go on.
   */
  refusePath?: (input: string) => string | null;
}

export interface Root {
  id: string;
  /** The configured path, lexically normal. Paths are reported under it. */
  path: string;
  mode: RootMode;
  /** Absolute and lexically normal. */
  stateDir: string;
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
 * The directory under each of the box's roots where the files API keeps its
 * own state: the trash, upload scratch space and clones in progress. It lives
 * on the root's own volume so moving into and out of it is always a rename,
 * never a copy.
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
 * caller names, however it is spelled, reaches outside the roots.
 *
 * Beyond that, a root may be read-only, and the optional predicates hide
 * resolved paths outright or refuse writes to them (a machine's node passes
 * them; the box passes none).
 */
export class Roots {
  /** Where a relative path hangs: the first root configured. */
  readonly primary: Root;
  private readonly home: Root | undefined;
  private readonly roots: Root[];
  private readonly all: Root[];
  private readonly realCache = new Map<string, string>();
  private readonly caseInsensitive: boolean;
  private readonly isHidden: ((realPath: string) => boolean) | undefined;
  private readonly isWriteDenied: ((realPath: string) => boolean) | undefined;
  private readonly refusePath: ((input: string) => string | null) | undefined;
  private readonly holdsHidden: ((realPath: string) => boolean) | undefined;

  constructor(opts: RootsOptions) {
    this.roots = opts.roots.map((r) => ({ id: r.id, path: path.resolve(r.path), mode: r.mode, stateDir: path.resolve(r.stateDir) }));
    const first = this.roots[0];
    if (!first) throw new Error("at least one root is required");
    this.primary = first;
    this.home = this.roots.find((r) => r.id === "home");
    // Longest first, so a nested root (possible in tests) wins over its parent.
    this.all = [...this.roots].sort((a, b) => b.path.length - a.path.length);
    this.caseInsensitive = opts.caseInsensitive ?? false;
    this.isHidden = opts.isHidden;
    this.isWriteDenied = opts.isWriteDenied;
    this.refusePath = opts.refusePath;
    this.holdsHidden = opts.holdsHidden;
  }

  byId(id: string): Root {
    const root = this.roots.find((r) => r.id === id);
    if (!root) throw new FilesError(404, `no root named ${id}`, "not-found");
    return root;
  }

  list(): Root[] {
    return [...this.roots];
  }

  /** {@link within}, ignoring case when the roots were configured to. */
  inside(child: string, parent: string): boolean {
    return this.caseInsensitive ? within(child.toLowerCase(), parent.toLowerCase()) : within(child, parent);
  }

  /** True when a resolved path is hidden by the configured predicate. */
  hidden(realPath: string): boolean {
    return this.isHidden?.(realPath) ?? false;
  }

  /** A resolved path that is hidden reads as one that does not exist. */
  private assertVisible(realPath: string, where: string): void {
    if (this.hidden(realPath)) throw new FilesError(404, `${where} does not exist`, "not-found");
  }

  /** Refuse a change under a read-only root, or to a path the predicate denies. */
  private assertWritable(root: Root, realPath: string, where: string): void {
    if (root.mode === "read") throw new FilesError(403, `${root.path} is read-only`, "read-only");
    if (this.isWriteDenied?.(realPath)) throw new FilesError(403, `permission denied: ${where}`, "denied");
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
    return root.stateDir;
  }

  /** The state directory's name when it sits directly in its root, e.g. `.agentbox`. */
  stateName(root: Root): string | null {
    return path.dirname(root.stateDir) === root.path ? path.basename(root.stateDir) : null;
  }

  /** The state directory as resolved on disk, or null when it cannot be. */
  async realStateDir(root: Root): Promise<string | null> {
    if (within(root.stateDir, root.path)) {
      const real = await this.realRoot(root).catch(() => null);
      return real === null ? null : path.join(real, path.relative(root.path, root.stateDir));
    }
    return fsp.realpath(root.stateDir).catch(() => null);
  }

  /** Place a client path lexically. Throws for anything outside every root. */
  locate(input: unknown): Located {
    if (typeof input !== "string") throw new FilesError(400, "path required");
    if (input.length > MAX_PATH) throw new FilesError(400, "path too long");
    if (input.includes("\0")) throw new FilesError(400, "path contains a NUL byte");
    const refused = this.refusePath?.(input) ?? null;
    if (refused !== null) throw new FilesError(400, refused, "refused");
    if (hasEscapes(input)) {
      try {
        encodeName(input);
      } catch (err) {
        if (err instanceof NameError) throw new FilesError(400, err.message);
        throw err;
      }
    }
    let abs: string;
    if (input === "~" || input.startsWith("~/")) {
      if (!this.home) throw new FilesError(403, `${input} is outside every root`, "outside");
      abs = path.resolve(this.home.path, "." + input.slice(1));
    } else abs = path.resolve(this.primary.path, input === "" ? "." : input);
    const root = this.all.find((r) => this.inside(abs, r.path));
    if (!root) throw new FilesError(403, `${input} is outside ${this.outsideWhat()}`, "outside");
    return { root, abs };
  }

  /** What a path outside every root is said to be outside of. */
  private outsideWhat(): string {
    const ids = this.roots.map((r) => r.id);
    if (ids.length === 2 && ids[0] === "workspace" && ids[1] === "home") return "the workspace and home";
    return "every root";
  }

  /** True when `abs` is the root itself or inside its reserved state dirs. */
  isReserved(loc: Located): boolean {
    if (loc.abs === loc.root.path) return true;
    const state = this.stateDir(loc.root);
    if (this.inside(loc.abs, state) && this.inside(state, loc.abs)) return true;
    return RESERVED.some((d) => this.inside(loc.abs, path.join(state, d)));
  }

  /**
   * Refuse to change the root itself or the API's own state, anything under a
   * read-only root, and a path the write-denied predicate names (checked on
   * the resolved path when the reference carries one).
   */
  assertMutable(loc: Located | EntryRef | NewRef): void {
    if (loc.abs === loc.root.path) throw new FilesError(403, "the root itself cannot be changed", "reserved");
    if (this.isReserved(loc)) {
      throw new FilesError(403, `${loc.abs} holds agentbox's own state`, "reserved");
    }
    this.assertWritable(loc.root, "fs" in loc ? loc.fs : loc.abs, loc.abs);
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
      const real = await this.realStateDir(root);
      for (const [p, state] of [
        [ref.abs, lexical],
        [ref.fs, real],
      ] as const) {
        if (state && (this.inside(p, state) || this.inside(state, p))) {
          throw new FilesError(403, `${ref.abs} holds agentbox's own state`, "reserved");
        }
      }
    }
  }

  /** Refuse to copy an entry that holds a hidden path: the copy would show it. */
  assertCopyable(ref: EntryRef): void {
    if (this.holdsHidden?.(ref.fs)) throw new FilesError(403, `permission denied: ${ref.abs}`, "denied");
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
    if (!this.inside(real, rootReal)) {
      throw new FilesError(403, `${loc.abs} leads outside its root`, "outside");
    }
    this.assertVisible(real, loc.abs);
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
    this.assertVisible(fsp_, loc.abs);
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
        if (!this.inside(real, rootReal)) throw new FilesError(403, `${loc.abs} leads outside its root`, "outside");
        const st = await fsp.stat(fsPath(real));
        if (!st.isDirectory()) throw new FilesError(409, `${dir} is not a directory`, "not-a-directory");
        const created = path.join(real, ...missing.reverse());
        this.assertVisible(created, loc.abs);
        this.assertWritable(loc.root, created, loc.abs);
        return { ...loc, fs: created };
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
    if (!this.inside(dir, rootReal)) throw new FilesError(403, `${ref.abs} leads outside its root`, "outside");
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
    if (!this.inside(real, rootReal)) throw new FilesError(403, `${loc.abs} leads outside its root`, "outside");
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
