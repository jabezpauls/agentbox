import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listDirs } from "../src/fs.js";

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-fs-"));
  fs.mkdirSync(path.join(root, "alpha"));
  fs.mkdirSync(path.join(root, "beta"));
  fs.mkdirSync(path.join(root, ".hidden"));
  fs.mkdirSync(path.join(root, "alpha", "child"));
  fs.writeFileSync(path.join(root, "afile.txt"), "x");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("listDirs", () => {
  it("lists non-hidden directories sorted, excluding files", async () => {
    const entries = await listDirs(root, "");
    expect(entries).toEqual([
      { name: "alpha", path: "alpha" },
      { name: "beta", path: "beta" },
    ]);
  });

  it("lists a subdirectory with paths relative to root", async () => {
    const entries = await listDirs(root, "alpha");
    expect(entries).toEqual([{ name: "child", path: path.join("alpha", "child") }]);
  });

  it("rejects a `..` escape with RangeError", async () => {
    await expect(listDirs(root, "..")).rejects.toBeInstanceOf(RangeError);
    await expect(listDirs(root, "../..")).rejects.toBeInstanceOf(RangeError);
    await expect(listDirs(root, "alpha/../..")).rejects.toBeInstanceOf(RangeError);
  });

  it("neutralizes a leading slash instead of escaping to the filesystem root", async () => {
    const entries = await listDirs(root, "/alpha");
    expect(entries).toEqual([{ name: "child", path: path.join("alpha", "child") }]);
  });
});
