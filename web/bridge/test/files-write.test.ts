import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { FileEntry, TrashItem, UploadSession } from "@workbench/shared";
import { filesFixture, rawPath, type FilesFixture } from "./helpers/files.js";

let f: FilesFixture;
let ws: string;

beforeEach(async () => {
  f = await filesFixture({ maxChunk: 1024 });
  ws = f.workspace;
});

afterEach(async () => {
  await f.close();
});

const post = (url: string, payload: unknown) => f.app.inject({ method: "POST", url, payload: payload as object });
const read = (p: string) => fs.readFileSync(path.join(ws, p), "utf8");

describe("write, mkdir, move, copy", () => {
  it("writes a new file, refuses to clobber, and replaces only when asked", async () => {
    const first = await post("/api/files/write", { path: "notes/today.md", content: "# hi" });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ name: "today.md", type: "file", size: 4 });
    expect(read("notes/today.md")).toBe("# hi");

    const again = await post("/api/files/write", { path: "notes/today.md", content: "other" });
    expect(again.statusCode).toBe(409);
    expect(read("notes/today.md")).toBe("# hi");

    const replaced = await post("/api/files/write", { path: "notes/today.md", content: "new", overwrite: true });
    expect(replaced.statusCode).toBe(200);
    expect(read("notes/today.md")).toBe("new");
  });

  it("saves over a file in place, keeping its mode", async () => {
    fs.writeFileSync(path.join(ws, "tool.sh"), "#!/bin/sh\n");
    fs.chmodSync(path.join(ws, "tool.sh"), 0o750);
    const res = await post("/api/files/write", { path: "tool.sh", content: "#!/bin/sh\necho hi\n", overwrite: true });
    expect(res.statusCode).toBe(200);
    expect(fs.statSync(path.join(ws, "tool.sh")).mode & 0o777).toBe(0o750);
    // A save is not a delete: nothing goes to the trash.
    expect((await f.app.inject({ method: "GET", url: "/api/files/trash" })).json()).toEqual([]);
  });

  it("refuses a write that is too large, or not text", async () => {
    expect((await post("/api/files/write", { path: "big", content: "x".repeat(1024 * 1024 + 1) })).statusCode).toBe(413);
    expect((await post("/api/files/write", { path: "x", content: 42 })).statusCode).toBe(400);
  });

  it("makes directories, and succeeds again on the second click", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await post("/api/files/mkdir", { path: "a/b/c" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ type: "dir", path: path.join(ws, "a/b/c") });
    }
    fs.writeFileSync(path.join(ws, "file"), "");
    expect((await post("/api/files/mkdir", { path: "file" })).statusCode).toBe(409);
  });

  it("renames, refuses to clobber, and is safe to repeat", async () => {
    fs.writeFileSync(path.join(ws, "old.txt"), "o");
    fs.writeFileSync(path.join(ws, "taken.txt"), "t");
    const moved = await post("/api/files/move", { from: "old.txt", to: "sub/new.txt" });
    expect(moved.statusCode).toBe(200);
    expect(read("sub/new.txt")).toBe("o");
    // The retry finds nothing to move and changes nothing.
    expect((await post("/api/files/move", { from: "old.txt", to: "sub/new.txt" })).statusCode).toBe(404);
    expect((await post("/api/files/move", { from: "sub/new.txt", to: "taken.txt" })).statusCode).toBe(409);
    expect(read("taken.txt")).toBe("t");
  });

  it("with overwrite, puts what it replaces in the trash rather than destroying it", async () => {
    fs.writeFileSync(path.join(ws, "a.txt"), "a");
    fs.writeFileSync(path.join(ws, "b.txt"), "b");
    expect((await post("/api/files/move", { from: "a.txt", to: "b.txt", overwrite: true })).statusCode).toBe(200);
    expect(read("b.txt")).toBe("a");
    const trash = (await f.app.inject({ method: "GET", url: "/api/files/trash" })).json() as TrashItem[];
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ name: "b.txt", originalPath: path.join(ws, "b.txt") });
  });

  it("refuses to move a directory into itself, the root, or the trash", async () => {
    fs.mkdirSync(path.join(ws, "d"));
    expect((await post("/api/files/move", { from: "d", to: "d/inner" })).statusCode).toBe(400);
    expect((await post("/api/files/move", { from: "", to: "elsewhere" })).statusCode).toBe(403);
    expect((await post("/api/files/move", { from: "d", to: ".agentbox/trash/d" })).statusCode).toBe(403);
    expect((await post("/api/files/move", { from: "d", to: "/etc/d" })).statusCode).toBe(403);
    expect((await post("/api/files/move", { from: "d", to: "../escape" })).statusCode).toBe(403);
  });

  it("never copies or moves agentbox's own state, however it is named", async () => {
    // The reviewer's case: a copy of .agentbox is built inside .agentbox/uploads
    // and would copy itself until the disk filled.
    const trash = path.join(ws, ".agentbox", "trash", "a".repeat(24));
    fs.mkdirSync(trash, { recursive: true });
    fs.writeFileSync(path.join(trash, "big"), Buffer.alloc(1024 * 1024));
    fs.mkdirSync(path.join(ws, ".agentbox", "review"), { recursive: true });
    fs.symlinkSync(".agentbox", path.join(ws, "state-link"));
    fs.mkdirSync(path.join(f.home, ".agentbox", "review"), { recursive: true });
    for (const from of [".agentbox", ".agentbox/trash", ".agentbox/review", "", "state-link/trash", "~/.agentbox/review", "~"]) {
      for (const op of ["copy", "move"]) {
        const res = await post(`/api/files/${op}`, { from, to: `copied-${op}-${from.replace(/\W/g, "_")}` });
        expect(res.statusCode, `${op} ${from}`).toBe(403);
      }
    }
    // Refused before any scratch work began.
    expect(fs.existsSync(path.join(ws, ".agentbox", "uploads"))).toBe(false);
    // The link itself is not state: it can be copied as a link.
    expect((await post("/api/files/copy", { from: "state-link", to: "state-link-2" })).statusCode).toBe(200);
    expect(fs.readlinkSync(path.join(ws, "state-link-2"))).toBe(".agentbox");
  });

  it("moves a symlink as a link, and between the two roots", async () => {
    fs.symlinkSync(f.base, path.join(ws, "out"));
    expect((await post("/api/files/move", { from: "out", to: "out2" })).statusCode).toBe(200);
    expect(fs.readlinkSync(path.join(ws, "out2"))).toBe(f.base);
    fs.writeFileSync(path.join(ws, "travel.txt"), "t");
    const res = await post("/api/files/move", { from: "travel.txt", to: "~/travel.txt" });
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(f.home, "travel.txt"), "utf8")).toBe("t");
  });

  it("copies a tree byte-exactly, links as links, odd names included", async () => {
    const src = path.join(ws, "src");
    fs.mkdirSync(path.join(src, "nested"), { recursive: true });
    fs.writeFileSync(path.join(src, "nested", "a.txt"), "a");
    fs.writeFileSync(rawPath(src, [0x62, 0xff]), "raw");
    fs.writeFileSync(path.join(src, "line\nbreak"), "nl");
    fs.symlinkSync("nested/a.txt", path.join(src, "rel-link"));
    const res = await post("/api/files/copy", { from: "src", to: "copy" });
    expect(res.statusCode, res.body).toBe(200);
    const names = fs.readdirSync(path.join(ws, "copy"), { encoding: "buffer" }).map((b) => b.toString("hex")).sort();
    const want = fs.readdirSync(src, { encoding: "buffer" }).map((b) => b.toString("hex")).sort();
    expect(names).toEqual(want);
    expect(fs.readlinkSync(path.join(ws, "copy", "rel-link"))).toBe("nested/a.txt");
    expect(fs.readFileSync(rawPath(path.join(ws, "copy"), [0x62, 0xff]), "utf8")).toBe("raw");
    // A second click finds the name taken.
    expect((await post("/api/files/copy", { from: "src", to: "copy" })).statusCode).toBe(409);
    expect((await post("/api/files/copy", { from: "src", to: "src/inside" })).statusCode).toBe(400);
    // No scratch copy is left behind.
    expect(fs.readdirSync(path.join(ws, ".agentbox", "uploads"))).toEqual([]);
  });
});

describe("trash", () => {
  it("trashes, lists, restores, and a double click is harmless", async () => {
    fs.mkdirSync(path.join(ws, "proj"));
    fs.writeFileSync(path.join(ws, "proj", "x.ts"), "x");
    const first = await post("/api/files/trash", { paths: ["proj/x.ts"] });
    expect(first.statusCode).toBe(200);
    expect(first.json().trashed).toHaveLength(1);
    expect(fs.existsSync(path.join(ws, "proj", "x.ts"))).toBe(false);

    const second = await post("/api/files/trash", { paths: ["proj/x.ts"] });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ trashed: [], missing: [path.join(ws, "proj", "x.ts")] });

    const items = (await f.app.inject({ method: "GET", url: "/api/files/trash" })).json() as TrashItem[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "x.ts", type: "file", size: 1, root: "workspace" });

    // Restoring recreates the parent if it has gone too.
    fs.rmdirSync(path.join(ws, "proj"));
    const restored = await post(`/api/files/trash/${items[0]!.id}/restore`, {});
    expect(restored.statusCode, restored.body).toBe(200);
    expect(read("proj/x.ts")).toBe("x");
    expect((await post(`/api/files/trash/${items[0]!.id}/restore`, {})).statusCode).toBe(404);
  });

  it("will not restore over something new, but will restore elsewhere", async () => {
    fs.writeFileSync(path.join(ws, "doc.md"), "old");
    const id = (await post("/api/files/trash", { paths: ["doc.md"] })).json().trashed[0].id as string;
    fs.writeFileSync(path.join(ws, "doc.md"), "new");
    expect((await post(`/api/files/trash/${id}/restore`, {})).statusCode).toBe(409);
    const res = await post(`/api/files/trash/${id}/restore`, { to: "doc (restored).md" });
    expect(res.statusCode).toBe(200);
    expect(read("doc (restored).md")).toBe("old");
    expect(read("doc.md")).toBe("new");
  });

  it("deletes for good only from the trash, odd names included", async () => {
    const d = path.join(ws, "gone");
    fs.mkdirSync(d);
    fs.writeFileSync(rawPath(d, [0xfe, 0xff]), "x");
    fs.writeFileSync(path.join(d, "a\nb"), "y");
    const id = (await post("/api/files/trash", { paths: ["gone"] })).json().trashed[0].id as string;
    const del = await f.app.inject({ method: "DELETE", url: `/api/files/trash/${id}` });
    expect(del.statusCode).toBe(204);
    expect(fs.readdirSync(path.join(ws, ".agentbox", "trash"))).toEqual([]);
    expect((await f.app.inject({ method: "DELETE", url: `/api/files/trash/${id}` })).statusCode).toBe(404);
  });

  it("keeps each root's trash on its own volume, and empties them all", async () => {
    fs.writeFileSync(path.join(ws, "w.txt"), "w");
    fs.writeFileSync(path.join(f.home, "h.txt"), "h");
    await post("/api/files/trash", { paths: ["w.txt", "~/h.txt"] });
    expect(fs.readdirSync(path.join(ws, ".agentbox", "trash"))).toHaveLength(1);
    expect(fs.readdirSync(path.join(f.home, ".agentbox", "trash"))).toHaveLength(1);
    const res = await f.app.inject({ method: "DELETE", url: "/api/files/trash" });
    expect(res.json()).toEqual({ removed: 2 });
    expect((await f.app.inject({ method: "GET", url: "/api/files/trash" })).json()).toEqual([]);
  });

  it("refuses the root, its own state, bad ids and paths outside", async () => {
    for (const paths of [[""], [".agentbox"], [".agentbox/trash"], ["/etc/passwd"], ["../x"]]) {
      expect((await post("/api/files/trash", { paths })).statusCode, String(paths)).toBe(403);
    }
    expect((await post("/api/files/trash", { paths: [] })).statusCode).toBe(400);
    expect((await post("/api/files/trash/..%2f..%2fetc/restore", {})).statusCode).toBe(400);
    expect((await post("/api/files/trash/nothex/restore", {})).statusCode).toBe(400);
  });

  it("trashes a symlink, not what it points at", async () => {
    fs.writeFileSync(path.join(f.base, "keep.txt"), "keep");
    fs.symlinkSync(path.join(f.base, "keep.txt"), path.join(ws, "link"));
    expect((await post("/api/files/trash", { paths: ["link"] })).statusCode).toBe(200);
    expect(fs.readFileSync(path.join(f.base, "keep.txt"), "utf8")).toBe("keep");
  });
});

describe("chunked uploads", () => {
  const put = (id: string, offset: number, body: Buffer | string) =>
    f.app.inject({
      method: "PUT",
      url: `/api/files/uploads/${id}?offset=${offset}`,
      headers: { "content-type": "application/octet-stream" },
      payload: body,
    });

  async function start(p: string, size: number, overwrite = false): Promise<string> {
    const res = await post("/api/files/uploads", { path: p, size, overwrite });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as UploadSession & { uploadId: string };
    expect(body.uploadId).toBe(body.id);
    return body.uploadId;
  }

  it("assembles chunks, survives a resent chunk, and refuses a gap", async () => {
    const data = Buffer.from("a".repeat(1024) + "b".repeat(1024) + "c".repeat(100));
    const id = await start("up/data.bin", data.length);
    expect((await put(id, 0, data.subarray(0, 1024))).json()).toMatchObject({ received: 1024 });
    // The same chunk again, as a retry after a dropped response would.
    expect((await put(id, 0, data.subarray(0, 1024))).json()).toMatchObject({ received: 1024 });
    // A chunk from the future is refused with where to resume.
    const gap = await put(id, 2048, data.subarray(2048));
    expect(gap.statusCode).toBe(409);
    expect(gap.json().code).toBe("offset:1024");
    await put(id, 1024, data.subarray(1024, 2048));
    // Finishing early says how far it got.
    expect((await post(`/api/files/uploads/${id}/finish`, {})).json().code).toBe("offset:2048");
    await put(id, 2048, data.subarray(2048));

    const status = await f.app.inject({ method: "GET", url: `/api/files/uploads/${id}` });
    expect(status.json()).toMatchObject({ received: data.length, size: data.length, done: false });

    const done = await post(`/api/files/uploads/${id}/finish`, {});
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ name: "data.bin", size: data.length });
    expect(fs.readFileSync(path.join(ws, "up", "data.bin")).equals(data)).toBe(true);
    // Finishing twice answers the same.
    const again = await post(`/api/files/uploads/${id}/finish`, {});
    expect(again.json()).toEqual(done.json());
    // And nothing more can be sent to it.
    expect((await put(id, 0, "x")).statusCode).toBe(409);
  });

  it("truncates bytes a resent tail left past the end", async () => {
    const id = await start("t.bin", 4);
    await put(id, 0, "abcd");
    await put(id, 2, "cd");
    expect((await post(`/api/files/uploads/${id}/finish`, {})).statusCode).toBe(200);
    expect(read("t.bin")).toBe("abcd");
  });

  it("refuses a chunk over the cap or past the declared size", async () => {
    const id = await start("cap.bin", 5000);
    const big = await put(id, 0, Buffer.alloc(1025));
    expect(big.statusCode).toBe(413);
    const small = await start("small.bin", 3);
    expect((await put(small, 0, "abcd")).statusCode).toBe(400);
    expect((await f.app.inject({ method: "GET", url: `/api/files/uploads/${small}` })).json().received).toBe(0);
  });

  it("will not replace an existing file unless asked, and never a directory", async () => {
    fs.writeFileSync(path.join(ws, "exists.txt"), "old");
    expect((await post("/api/files/uploads", { path: "exists.txt", size: 1 })).statusCode).toBe(409);
    fs.mkdirSync(path.join(ws, "adir"));
    expect((await post("/api/files/uploads", { path: "adir", size: 1, overwrite: true })).statusCode).toBe(409);
    const id = await start("exists.txt", 3, true);
    await put(id, 0, "new");
    expect((await post(`/api/files/uploads/${id}/finish`, {})).statusCode).toBe(200);
    expect(read("exists.txt")).toBe("new");
  });

  it("sends the file an upload replaces to the trash, and keeps its mode", async () => {
    fs.writeFileSync(path.join(ws, "run.sh"), "#!/bin/sh\necho old\n", { mode: 0o755 });
    fs.chmodSync(path.join(ws, "run.sh"), 0o755);
    const id = await start("run.sh", 5, true);
    await put(id, 0, "echo!");
    expect((await post(`/api/files/uploads/${id}/finish`, {})).statusCode).toBe(200);
    expect(read("run.sh")).toBe("echo!");
    expect(fs.statSync(path.join(ws, "run.sh")).mode & 0o777).toBe(0o755);
    const trash = (await f.app.inject({ method: "GET", url: "/api/files/trash" })).json() as TrashItem[];
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ name: "run.sh", originalPath: path.join(ws, "run.sh") });
    // And it comes back: restored beside the new one.
    const restored = await post(`/api/files/trash/${trash[0]!.id}/restore`, { to: "run.sh.old" });
    expect(restored.statusCode).toBe(200);
    expect(read("run.sh.old")).toBe("#!/bin/sh\necho old\n");
  });

  it("does not clobber a file that appeared while uploading", async () => {
    const id = await start("race.txt", 2);
    await put(id, 0, "up");
    fs.writeFileSync(path.join(ws, "race.txt"), "someone else");
    expect((await post(`/api/files/uploads/${id}/finish`, {})).statusCode).toBe(409);
    expect(read("race.txt")).toBe("someone else");
  });

  it("uploads an empty file, cancels, and refuses paths outside", async () => {
    const empty = await start("empty.txt", 0);
    expect((await post(`/api/files/uploads/${empty}/finish`, {})).statusCode).toBe(200);
    expect(read("empty.txt")).toBe("");

    const id = await start("cancel.txt", 10);
    expect((await f.app.inject({ method: "DELETE", url: `/api/files/uploads/${id}` })).statusCode).toBe(204);
    expect((await f.app.inject({ method: "GET", url: `/api/files/uploads/${id}` })).statusCode).toBe(404);

    for (const p of ["/etc/x", "../x", ".agentbox/uploads/x"]) {
      expect((await post("/api/files/uploads", { path: p, size: 1 })).statusCode, p).toBe(403);
    }
    expect((await post("/api/files/uploads", { path: "x", size: -1 })).statusCode).toBe(400);
    expect((await put("..%2f..%2fetc", 0, "x")).statusCode).toBe(400);
    expect((await put("not-an-upload-id", 0, "x")).statusCode).toBe(400);
  });

  it("sweeps uploads abandoned for a day, and keeps live ones", async () => {
    const stale = await start("stale.bin", 10);
    const fresh = await start("fresh.bin", 10);
    const dir = path.join(ws, ".agentbox", "uploads");
    // Age the stale upload's files and its own record.
    const rec = JSON.parse(fs.readFileSync(path.join(dir, `${stale}.json`), "utf8")) as { updated: number };
    rec.updated -= 25 * 60 * 60 * 1000;
    fs.writeFileSync(path.join(dir, `${stale}.json`), JSON.stringify(rec));
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const ext of ["json", "part"]) fs.utimesSync(path.join(dir, `${stale}.${ext}`), old, old);

    expect(await f.files.uploads.sweep()).toBe(2);
    expect((await f.app.inject({ method: "GET", url: `/api/files/uploads/${stale}` })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "GET", url: `/api/files/uploads/${fresh}` })).statusCode).toBe(200);
  });
});

describe("stat", () => {
  it("describes one entry, a symlink as itself", async () => {
    fs.symlinkSync("target-missing", path.join(ws, "dangling"));
    const res = await f.app.inject({ method: "GET", url: "/api/files/stat?path=dangling" });
    expect(res.statusCode).toBe(200);
    expect(res.json() as FileEntry).toMatchObject({ type: "symlink", target: "target-missing", targetType: null });
    expect((await f.app.inject({ method: "GET", url: "/api/files/stat?path=nope" })).statusCode).toBe(404);
  });
});
