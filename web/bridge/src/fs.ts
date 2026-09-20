import { readdir } from "node:fs/promises";
import path from "node:path";
import type { DirEntry } from "@workbench/shared";

/**
 * List the non-hidden subdirectories of `rel` under `root`, with each entry's
 * path expressed relative to `root`. The resolved target must stay within
 * `root`; a `..` escape (or any path that resolves outside) throws a
 * `RangeError`. A leading slash in `rel` is treated as relative to `root`, not
 * the filesystem root.
 */
export async function listDirs(root: string, rel: string): Promise<DirEntry[]> {
  const resolved = path.resolve(root, "." + "/" + rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new RangeError(`path escapes root: ${rel}`);
  }
  const entries = await readdir(resolved, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: path.relative(root, path.join(resolved, e.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
