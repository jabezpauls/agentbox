import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "@workbench/shared";

let folder: FileEntry[] = [];
const list = vi.fn(async (path: string, opts: { offset?: number; limit?: number } = {}) => {
  const offset = opts.offset ?? 0;
  const entries = folder.slice(offset, offset + (opts.limit ?? 1000));
  return { path, root: "workspace", entries, total: folder.length, offset, truncated: offset + entries.length < folder.length };
});
vi.mock("../../files/api.ts", () => ({ filesApi: { list: (...a: Parameters<typeof list>) => list(...a) } }));

const { readFolders } = await import("./FileTree.tsx");

const dir = (i: number): FileEntry => ({ name: `d${i}`, path: `/w/d${i}`, type: "dir", size: 0, mtime: 0 });
const file = (i: number): FileEntry => ({ name: `f${i}`, path: `/w/f${i}`, type: "file", size: 1, mtime: 0 });

beforeEach(() => list.mockClear());

describe("readFolders (the tree)", () => {
  it("reads past the first page while it is still all folders", async () => {
    // Folders come first: 1,500 of them, then 3,000 files.
    folder = [...Array.from({ length: 1500 }, (_, i) => dir(i)), ...Array.from({ length: 3000 }, (_, i) => file(i))];
    const { dirs, more } = await readFolders("/w", false);
    expect(dirs).toHaveLength(1500);
    expect(more).toBe(false);
    // And stops once a page ends in a file: the rest are files.
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("reads one page of a folder with few subfolders", async () => {
    folder = [dir(0), ...Array.from({ length: 4000 }, (_, i) => file(i))];
    const { dirs, more } = await readFolders("/w", false);
    expect(dirs).toHaveLength(1);
    expect(more).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("says there are more after ten pages of folders", async () => {
    folder = Array.from({ length: 12_000 }, (_, i) => dir(i));
    const { dirs, more } = await readFolders("/w", false);
    expect(dirs).toHaveLength(10_000);
    expect(more).toBe(true);
  });
});
