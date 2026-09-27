import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { encodePathParam, type FileEntry, type FileListing } from "@workbench/shared";
import { filesFixture, pct, rawPath, type FilesFixture } from "./helpers/files.js";

let f: FilesFixture;
let ws: string;

const q = (p: string) => encodePathParam(p);

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

beforeAll(async () => {
  f = await filesFixture();
  ws = f.workspace;
  fs.mkdirSync(path.join(ws, "b-dir"));
  fs.mkdirSync(path.join(ws, "a-dir"));
  fs.writeFileSync(path.join(ws, "file10.txt"), "ten");
  fs.writeFileSync(path.join(ws, "file9.txt"), "nine");
  fs.writeFileSync(path.join(ws, ".hidden"), "h");
  fs.writeFileSync(path.join(ws, "page.html"), "<script>alert(1)</script>");
  fs.writeFileSync(path.join(ws, "pic.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(ws, "img.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  fs.writeFileSync(path.join(ws, "blob.bin"), Buffer.from([0, 1, 2, 3, 255]));
  fs.writeFileSync(path.join(ws, "notes"), "plain text without an extension\n");
  fs.writeFileSync(path.join(ws, "line\nbreak.txt"), "newline name");
  fs.writeFileSync(rawPath(ws, [0x6e, 0xff, 0x2e, 0x74, 0x78, 0x74]), "not utf-8");
  fs.symlinkSync("a-dir", path.join(ws, "link-in"));
  fs.symlinkSync(f.base, path.join(ws, "link-out"));
  fs.symlinkSync("nowhere", path.join(ws, "link-broken"));
});

afterAll(async () => {
  await f.close();
});

async function list(p: string, extra = ""): Promise<FileListing> {
  const res = await f.app.inject({ method: "GET", url: `/api/files/list?path=${q(p)}${extra}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as FileListing;
}

describe("listing", () => {
  it("lists directories first, then names in natural order, without hidden entries", async () => {
    const l = await list(ws);
    const names = l.entries.map((e) => e.name);
    expect(names.slice(0, 2)).toEqual(["a-dir", "b-dir"]);
    expect(names.indexOf("file9.txt")).toBeLessThan(names.indexOf("file10.txt"));
    expect(names).not.toContain(".hidden");
    expect(l.root).toBe("workspace");
    expect(l.truncated).toBe(false);
    expect((await list(ws, "&hidden=1")).entries.map((e) => e.name)).toContain(".hidden");
  });

  it("defaults to the workspace root and reports sizes and times", async () => {
    const l = await list("");
    expect(l.path).toBe(ws);
    const ten = l.entries.find((e) => e.name === "file10.txt") as FileEntry;
    expect(ten).toMatchObject({ type: "file", size: 3, path: path.join(ws, "file10.txt") });
    expect(ten.mtime).toBeGreaterThan(0);
  });

  it("describes symlinks and where they lead, without following one out", async () => {
    const entries = (await list(ws)).entries;
    const by = (n: string) => entries.find((e) => e.name === n) as FileEntry;
    expect(by("link-in")).toMatchObject({ type: "symlink", target: "a-dir", targetType: "dir" });
    expect(by("link-out")).toMatchObject({ type: "symlink", targetType: null });
    expect(by("link-broken")).toMatchObject({ type: "symlink", target: "nowhere", targetType: null });
  });

  it("lists a name with a newline and a name that is not UTF-8, both addressable", async () => {
    const entries = (await list(ws)).entries;
    const nl = entries.find((e) => e.name === "line\nbreak.txt") as FileEntry;
    expect(nl).toBeTruthy();
    const raw = entries.find((e) => e.rawName) as FileEntry;
    expect(raw.name).toBe("n\udcff.txt");
    // Both come back by the path the listing gave.
    for (const e of [nl, raw]) {
      const res = await f.app.inject({ method: "GET", url: `/api/files/raw?path=${q(e.path)}` });
      expect(res.statusCode).toBe(200);
    }
    // And by raw percent-encoded bytes, as any client might send them.
    const res = await f.app.inject({ method: "GET", url: `/api/files/stat?path=${pct(rawPath(ws, [0x6e, 0xff, 0x2e, 0x74, 0x78, 0x74]))}` });
    expect(res.json()).toMatchObject({ name: "n\udcff.txt", rawName: true });
  });

  it("refuses to list through a link that leads out, and outside the roots", async () => {
    for (const p of ["link-out", "../", "/etc", path.join(ws, "link-out")]) {
      const res = await f.app.inject({ method: "GET", url: `/api/files/list?path=${q(p)}` });
      expect(res.statusCode, p).toBe(403);
    }
  });

  it("caps a huge directory at 5000 entries a page, with a flag and an offset", async () => {
    const big = path.join(ws, "big");
    fs.mkdirSync(big);
    for (let i = 0; i < 5200; i++) fs.writeFileSync(path.join(big, `f${String(i).padStart(5, "0")}`), "");
    const first = await list(big);
    expect(first.entries).toHaveLength(5000);
    expect(first.total).toBe(5200);
    expect(first.truncated).toBe(true);
    const second = await list(big, "&offset=5000");
    expect(second.entries).toHaveLength(200);
    expect(second.truncated).toBe(false);
    expect(second.entries[0]?.name).toBe("f05000");
  });

  it("reads a big folder once for all its pages, and sees a change at once", async () => {
    const big = path.join(ws, "paged");
    fs.mkdirSync(big);
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(big, `p${i}`), "");
    const readdir = vi.spyOn(fsp, "readdir");
    const reads = () => readdir.mock.calls.filter((c) => String(c[0]) === fs.realpathSync(big)).length;
    await list(big, "&limit=100");
    await list(big, "&limit=100&offset=100");
    await list(big, "&limit=100&offset=200");
    expect(reads()).toBe(1);
    fs.writeFileSync(path.join(big, "p-new"), "");
    const after = await list(big, "&limit=100&offset=200");
    expect(reads()).toBe(2);
    expect(after.total).toBe(301);
    readdir.mockRestore();
  });

  it("marks git status, rolling changes up to directories", async () => {
    const repo = path.join(ws, "repo");
    fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "deep", "kept.ts"), "1");
    fs.writeFileSync(path.join(repo, "clean.ts"), "1");
    fs.writeFileSync(path.join(repo, ".gitignore"), "build/\n");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    fs.writeFileSync(path.join(repo, "src", "deep", "kept.ts"), "2");
    fs.writeFileSync(path.join(repo, "new file.ts"), "n");
    fs.mkdirSync(path.join(repo, "build"));
    fs.writeFileSync(path.join(repo, "build", "out.js"), "o");
    fs.mkdirSync(path.join(repo, "fresh"));
    fs.writeFileSync(path.join(repo, "fresh", "a"), "a");

    const top = (await list(repo)).entries;
    const st = (n: string) => top.find((e) => e.name === n)?.git;
    expect(st("src")).toBe("modified");
    expect(st("new file.ts")).toBe("untracked");
    expect(st("build")).toBe("ignored");
    expect(st("fresh")).toBe("untracked");
    expect(st("clean.ts")).toBeNull();
    expect((await list(path.join(repo, "src", "deep"))).entries[0]?.git).toBe("modified");
    expect((await list(path.join(repo, "build"))).entries[0]?.git).toBe("ignored");
    // Outside any repository there is nothing to say.
    expect((await list(ws)).entries.find((e) => e.name === "a-dir")?.git).toBeUndefined();
  });
});

describe("raw", () => {
  const get = (p: string, extra = "", headers: Record<string, string> = {}) =>
    f.app.inject({ method: "GET", url: `/api/files/raw?path=${q(p)}${extra}`, headers });

  it("always sends the sandbox and nosniff headers", async () => {
    for (const [p, extra] of [["file10.txt", ""], ["page.html", ""], ["page.html", "&inline=1"], ["img.png", "&inline=1"]] as const) {
      const res = await get(p, extra);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-security-policy"]).toBe("sandbox");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("shows pictures and text inline when asked, and never HTML or SVG as themselves", async () => {
    const png = await get("img.png", "&inline=1");
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.headers["content-disposition"]).toMatch(/^inline;/);

    for (const p of ["page.html", "pic.svg", "notes", "file10.txt"]) {
      const res = await get(p, "&inline=1");
      expect(res.headers["content-type"], p).toBe("text/plain; charset=utf-8");
      expect(res.headers["content-disposition"], p).toMatch(/^inline;/);
    }
    const bin = await get("blob.bin", "&inline=1");
    expect(bin.headers["content-disposition"]).toMatch(/^attachment;/);
  });

  it("downloads everything as an attachment by default, HTML included", async () => {
    const res = await get("page.html");
    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.body).toBe("<script>alert(1)</script>");
  });

  it("refuses to be loaded as a script, worker or stylesheet", async () => {
    fs.writeFileSync(path.join(ws, "evil.js"), "alert(document.domain)");
    for (const dest of ["script", "worker", "sharedworker", "serviceworker", "style", "audioworklet", "paintworklet"]) {
      const res = await get("evil.js", "", { "sec-fetch-dest": dest });
      expect(res.statusCode, dest).toBe(403);
      expect(res.body).not.toContain("alert");
    }
    for (const dest of ["document", "iframe", "image", "empty"]) {
      expect((await get("evil.js", "", { "sec-fetch-dest": dest })).statusCode, dest).toBe(200);
    }
    // And a script or stylesheet never carries a type a browser would run.
    for (const p of ["evil.js"]) {
      expect((await get(p)).headers["content-type"]).toBe("text/plain");
    }
  });

  it("keeps a hostile filename out of the header", async () => {
    const res = await get("line\nbreak.txt");
    const cd = res.headers["content-disposition"] as string;
    expect(cd).not.toContain("\n");
    expect(cd).toContain("filename*=UTF-8''line%0Abreak.txt");
  });

  it("serves a byte range, and refuses an unsatisfiable one", async () => {
    const res = await get("file10.txt", "", { range: "bytes=1-" });
    expect(res.statusCode).toBe(206);
    expect(res.body).toBe("en");
    expect(res.headers["content-range"]).toBe("bytes 1-2/3");
    expect((await get("file10.txt", "", { range: "bytes=9-" })).statusCode).toBe(416);
  });

  it("refuses a directory, a missing file and a link out", async () => {
    expect((await get("a-dir")).statusCode).toBe(409);
    expect((await get("missing")).statusCode).toBe(404);
    fs.writeFileSync(path.join(f.base, "outside.txt"), "secret");
    expect((await get("link-out/outside.txt")).statusCode).toBe(403);
    // Out and back in again ends inside the root, which is where it counts.
    expect((await get("link-out/workspace/file10.txt")).statusCode).toBe(200);
  });
});

describe("zip", () => {
  function entriesOf(buf: Buffer): string[] {
    const file = path.join(f.base, `z-${Date.now()}.zip`);
    fs.writeFileSync(file, buf);
    const out = execFileSync("python3", [
      "-c",
      "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint('\\n'.join(sorted(n for n in z.namelist())))",
      file,
    ]).toString();
    return out.trim().split("\n");
  }

  it("streams a directory tree, leaving symlinks out", async () => {
    const tree = path.join(ws, "tree");
    fs.mkdirSync(path.join(tree, "sub", "empty"), { recursive: true });
    fs.writeFileSync(path.join(tree, "a.txt"), "a".repeat(10_000));
    fs.writeFileSync(path.join(tree, "sub", "b.png"), "b");
    fs.symlinkSync(f.base, path.join(tree, "sub", "out"));
    const res = await f.app.inject({ method: "GET", url: `/api/files/zip?path=${q(tree)}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toContain('filename="tree.zip"');
    expect(res.headers["content-security-policy"]).toBe("sandbox");
    expect(entriesOf(res.rawPayload)).toEqual(["tree/", "tree/a.txt", "tree/sub/", "tree/sub/b.png", "tree/sub/empty/"]);
  });

  it("zips several paths side by side, and names with odd bytes", async () => {
    const res = await f.app.inject({
      method: "GET",
      url: `/api/files/zip?path=${q("file9.txt")}&path=${q("a-dir")}&path=${pct(rawPath(ws, [0x6e, 0xff, 0x2e, 0x74, 0x78, 0x74]))}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain('filename="files.zip"');
    expect(entriesOf(res.rawPayload)).toEqual(["a-dir/", "file9.txt", "n�.txt"]);
  });

  it("leaves the root's own trash and scratch space out of a zip of the root", async () => {
    fs.mkdirSync(path.join(ws, ".agentbox", "trash", "x"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".agentbox", "trash", "x", "meta.json"), "{}");
    const res = await f.app.inject({ method: "GET", url: `/api/files/zip?path=${q(ws)}` });
    expect(res.statusCode).toBe(200);
    const names = entriesOf(res.rawPayload);
    expect(names).toContain("workspace/file9.txt");
    expect(names.some((n) => n.includes(".agentbox"))).toBe(false);
  });

  it("refuses a path outside before sending anything", async () => {
    const res = await f.app.inject({ method: "GET", url: `/api/files/zip?path=${q("link-out")}` });
    expect(res.statusCode).toBe(403);
  });
});

describe("search", () => {
  it("finds files by name, best match first, with the walker", async () => {
    const d = path.join(ws, "searchable");
    fs.mkdirSync(path.join(d, "deep", "er"), { recursive: true });
    fs.writeFileSync(path.join(d, "deep", "er", "widget.ts"), "");
    fs.writeFileSync(path.join(d, "widget.ts"), "");
    fs.writeFileSync(path.join(d, "my-widget-helper.ts"), "");
    fs.mkdirSync(path.join(d, "node_modules", "widget"), { recursive: true });
    const res = await f.app.inject({ method: "GET", url: `/api/files/search?q=widget&path=${q(d)}` });
    expect(res.statusCode).toBe(200);
    const paths = (res.json() as FileEntry[]).map((e) => path.relative(d, e.path));
    expect(paths).toEqual(["widget.ts", "deep/er/widget.ts", "my-widget-helper.ts"]);
  });
});
