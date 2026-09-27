import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { encodePathParam } from "@workbench/shared";
import { entryComponent } from "../src/files/zip.js";
import { filesFixture, rawPath, type FilesFixture } from "./helpers/files.js";

let f: FilesFixture;
let port: number;
let tree: string;

beforeAll(async () => {
  f = await filesFixture();
  await f.app.listen({ host: "127.0.0.1", port: 0 });
  port = (f.app.server.address() as AddressInfo).port;
  tree = path.join(f.workspace, "tree");
  for (let d = 0; d < 60; d++) {
    const dir = path.join(tree, `d${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let n = 0; n < 60; n++) fs.writeFileSync(path.join(dir, `f${n}.txt`), "x".repeat(4000));
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  await f.close();
});

function entriesOf(buf: Buffer): string[] {
  const file = path.join(f.base, `z-${Date.now()}.zip`);
  fs.writeFileSync(file, buf);
  const out = execFileSync("python3", [
    "-c",
    "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint('\\n'.join(sorted(z.namelist())))",
    file,
  ]).toString();
  return out.trim().split("\n");
}

describe("an abandoned zip", () => {
  it("stops walking the tree when the client goes away", async () => {
    const lstat = vi.spyOn(fsp, "lstat");
    const before = lstat.mock.calls.length;
    await new Promise<void>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/api/files/zip?path=${encodePathParam(tree)}`, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => resolve());
    });
    await new Promise((r) => setTimeout(r, 300));
    const settled = lstat.mock.calls.length;
    await new Promise((r) => setTimeout(r, 700));
    const later = lstat.mock.calls.length;
    lstat.mockRestore();
    // The tree has 3660 entries; the walk stopped well short and stays stopped.
    expect(settled - before).toBeLessThan(3660);
    expect(later).toBe(settled);
  });

  it("builds nothing for a HEAD", async () => {
    const lstat = vi.spyOn(fsp, "lstat");
    const before = lstat.mock.calls.length;
    const status = await new Promise<number>((resolve) => {
      const req = http.request(`http://127.0.0.1:${port}/api/files/zip?path=${encodePathParam(tree)}`, { method: "HEAD" }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.end();
    });
    await new Promise((r) => setTimeout(r, 200));
    const calls = lstat.mock.calls.length - before;
    lstat.mockRestore();
    expect(status).toBe(200);
    expect(calls).toBeLessThan(5);
  });
});

describe("zip entry names", () => {
  it("keeps names the format or the library would refuse", () => {
    expect(entryComponent("C:notes.txt")).toBe("C_notes.txt");
    expect(entryComponent("a\\b")).toBe("a_b");
    expect(entryComponent("n\udcff")).toBe("n�");
    expect(entryComponent("plain:colon")).toBe("plain:colon");
  });

  it("serves a drive-looking name instead of failing", async () => {
    fs.writeFileSync(path.join(f.workspace, "C:notes.txt"), "hello");
    const res = await f.app.inject({ method: "GET", url: `/api/files/zip?path=${encodePathParam(path.join(f.workspace, "C:notes.txt"))}` });
    expect(res.statusCode).toBe(200);
    expect(entriesOf(res.rawPayload)).toEqual(["C_notes.txt"]);
  });

  it("tells apart names that sanitising made alike", async () => {
    const d = path.join(f.workspace, "alike");
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "a\\b.txt"), "1");
    fs.writeFileSync(path.join(d, "a_b.txt"), "2");
    fs.writeFileSync(rawPath(d, [0x78, 0xff]), "3");
    fs.writeFileSync(rawPath(d, [0x78, 0xfe]), "4");
    const res = await f.app.inject({ method: "GET", url: `/api/files/zip?path=${encodePathParam(d)}` });
    expect(res.statusCode).toBe(200);
    const names = entriesOf(res.rawPayload);
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
    expect(names).toContain("alike/a_b.txt");
    expect(names).toContain("alike/a_b (2).txt");
    expect(names).toContain("alike/x�");
    expect(names).toContain("alike/x� (2)");
  });

  it("still zips a large tree completely", async () => {
    const res = await f.app.inject({ method: "GET", url: `/api/files/zip?path=${encodePathParam(tree)}` });
    expect(res.statusCode).toBe(200);
    expect(entriesOf(res.rawPayload)).toHaveLength(1 + 60 + 3600);
  });
});
