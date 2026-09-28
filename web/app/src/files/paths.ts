import type { FileRoot } from "@workbench/shared";

/**
 * Path arithmetic for the Files surface. Paths are absolute, POSIX, and may
 * hold any byte but `/` and NUL in a name — nothing here parses a name, it
 * only splits on `/`.
 */

export interface Roots {
  workspace: string;
  home: string;
}

export function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

export function basename(p: string): string {
  const t = trimSlash(p);
  return t.slice(t.lastIndexOf("/") + 1) || t;
}

export function dirname(p: string): string {
  const t = trimSlash(p);
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}

export function join(dir: string, name: string): string {
  return `${trimSlash(dir) === "/" ? "" : trimSlash(dir)}/${name}`;
}

/** `dir` itself or anything below it. */
export function isWithin(path: string, dir: string): boolean {
  const d = trimSlash(dir);
  return path === d || path.startsWith(d === "/" ? "/" : `${d}/`);
}

/** The absolute path a route's root and names stand for. */
export function toAbsolute(roots: Roots, root: FileRoot, rel: string[]): string {
  return rel.reduce((dir, name) => join(dir, name), trimSlash(roots[root]));
}

/** The route's root and names for an absolute path, or null when it is in neither root. */
export function toRelative(roots: Roots, path: string): { root: FileRoot; rel: string[] } | null {
  for (const root of ["workspace", "home"] as const) {
    const base = trimSlash(roots[root]);
    if (isWithin(path, base)) {
      const rest = path.slice(base.length).split("/").filter(Boolean);
      return { root, rel: rest };
    }
  }
  return null;
}

/** A name and its extension, split so a rename selects only the name: "a.test.ts" → ["a.test", ".ts"]. */
export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  if (i <= 0) return [name, ""];
  return [name.slice(0, i), name.slice(i)];
}

/** What is wrong with a name typed for a new or renamed entry, or null. */
export function nameProblem(name: string): string | null {
  if (!name.trim()) return "Enter a name.";
  if (name.includes("/")) return "A name cannot contain a slash.";
  if (name === "." || name === "..") return "That name is taken by the folder itself.";
  if (name.includes("\0")) return "A name cannot contain a NUL character.";
  if (name === ".agentbox") return "That name is reserved for the trash and uploads.";
  return null;
}

/**
 * A name not in `taken`, derived from `name` the way a file manager does:
 * "notes.md" → "notes copy.md" → "notes copy 2.md".
 */
export function freeName(name: string, taken: Set<string>, word = "copy"): string {
  const [stem, ext] = splitExt(name);
  let candidate = `${stem} ${word}${ext}`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem} ${word} ${n}${ext}`;
  return candidate;
}

/** "notes.md" → "notes (2).md", for an upload that must not replace what is there. */
export function numberedName(name: string, n: number): string {
  const [stem, ext] = splitExt(name);
  return `${stem} (${n})${ext}`;
}
