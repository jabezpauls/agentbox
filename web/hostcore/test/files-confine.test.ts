import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FilesError, Roots, type RootConfig } from "../src/files/roots.js";
import { tmpBase } from "./helpers/tmp.js";

let base: string;
let ws: string;
let home: string;
let outside: string;
let roots: Roots;

/** The box's two roots, each keeping its state in its own `.agentbox`. */
function boxRoots(ws: string, home: string): RootConfig[] {
  return [
    { id: "workspace", path: ws, mode: "write", stateDir: path.join(ws, ".agentbox") },
    { id: "home", path: home, mode: "write", stateDir: path.join(home, ".agentbox") },
  ];
}

async function status(p: Promise<unknown>): Promise<number | "ok"> {
  try {
    await p;
    return "ok";
  } catch (err) {
    if (err instanceof FilesError) return err.status;
    throw err;
  }
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(tmpBase(), "wb-confine-"));
  ws = path.join(base, "workspace");
  home = path.join(base, "home");
  outside = path.join(base, "outside");
  for (const d of [ws, home, outside, path.join(ws, "src"), path.join(ws, "real")]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(outside, "secret"), "s3cret");
  fs.writeFileSync(path.join(ws, "src", "a.ts"), "export {}");
  fs.symlinkSync(outside, path.join(ws, "escape"));
  fs.symlinkSync(path.join(outside, "secret"), path.join(ws, "secret-link"));
  fs.symlinkSync(path.join(ws, "real"), path.join(ws, "inside-link"));
  fs.symlinkSync("loop-b", path.join(ws, "loop-a"));
  fs.symlinkSync("loop-a", path.join(ws, "loop-b"));
  roots = new Roots({ roots: boxRoots(ws, home) });
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("placing a path", () => {
  it("hangs a relative path off the workspace and ~ off home", () => {
    expect(roots.locate("src/a.ts").abs).toBe(path.join(ws, "src/a.ts"));
    expect(roots.locate("").abs).toBe(ws);
    expect(roots.locate("~").abs).toBe(home);
    expect(roots.locate("~/x").root.id).toBe("home");
    expect(roots.locate(path.join(home, "y")).root.id).toBe("home");
  });

  it("collapses .. before deciding, and refuses what lands outside", () => {
    expect(roots.locate("src/../src/a.ts").abs).toBe(path.join(ws, "src/a.ts"));
    expect(() => roots.locate("../outside/secret")).toThrow(FilesError);
    expect(() => roots.locate("src/../../outside")).toThrow(FilesError);
    expect(() => roots.locate("~/../outside")).toThrow(FilesError);
  });

  it("refuses absolute paths outside both roots", () => {
    for (const p of ["/etc/passwd", "/", outside, path.join(outside, "secret"), `${ws}-evil/x`]) {
      expect(() => roots.locate(p), p).toThrow(expect.objectContaining({ status: 403 }));
    }
  });

  it("refuses a NUL byte, a non-string and an unpaired surrogate", () => {
    expect(() => roots.locate("a\0b")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => roots.locate(42)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => roots.locate("a\ud800")).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("resolving through symlinks", () => {
  it("follows a link that stays inside", async () => {
    const t = await roots.target("inside-link");
    expect(t.real).toBe(fs.realpathSync(path.join(ws, "real")));
    expect(t.abs).toBe(path.join(ws, "inside-link"));
  });

  it("refuses to read through a link that leads out", async () => {
    expect(await status(roots.target("escape/secret"))).toBe(403);
    expect(await status(roots.target("secret-link"))).toBe(403);
    expect(await status(roots.target("escape"))).toBe(403);
  });

  it("addresses the link itself when acting on the entry", async () => {
    // Trashing or renaming a link must be possible without following it.
    expect(await status(roots.entry("secret-link"))).toBe("ok");
    expect(await status(roots.entry("escape"))).toBe("ok");
    // But nothing beneath a link that leads out is reachable as an entry.
    expect(await status(roots.entry("escape/secret"))).toBe(403);
  });

  it("reports a symlink loop as a bad path, not a crash", async () => {
    expect(await status(roots.target("loop-a"))).toBe(400);
  });

  it("never creates through a link that leads out", async () => {
    expect(await status(roots.creatable("escape/new-file"))).toBe(403);
    expect(await status(roots.creatable("escape/deep/missing/new-file"))).toBe(403);
    expect(await status(roots.creatable("src/new-file"))).toBe("ok");
    expect(await status(roots.creatable("brand/new/dirs/file"))).toBe("ok");
  });

  it("creates missing parents one by one inside the root", async () => {
    const ref = await roots.creatable("made/for/you/file.txt");
    await roots.ensureParent(ref);
    expect(fs.statSync(path.join(ws, "made/for/you")).isDirectory()).toBe(true);
  });

  it("says 404 for a missing entry and 409 for a file used as a directory", async () => {
    expect(await status(roots.target("nope"))).toBe(404);
    expect(await status(roots.creatable("src/a.ts/child"))).toBe(409);
  });
});

describe("what may be changed", () => {
  it("protects the root itself and the API's own state", () => {
    for (const p of ["", "~", ".agentbox", ".agentbox/trash", ".agentbox/trash/x", ".agentbox/uploads/y", "~/.agentbox/clones"]) {
      expect(() => roots.assertMutable(roots.locate(p)), p).toThrow(expect.objectContaining({ status: 403 }));
    }
    expect(() => roots.assertMutable(roots.locate(".agentbox/review"))).not.toThrow();
    expect(() => roots.assertMutable(roots.locate("src/a.ts"))).not.toThrow();
  });
});

describe("roots configured beyond the box's two", () => {
  it("hangs relative paths off the first root, and has no ~ without a home", () => {
    const one = new Roots({ roots: [{ id: "code", path: ws, mode: "write", stateDir: path.join(base, "state") }] });
    expect(one.locate("src/a.ts").root.id).toBe("code");
    expect(() => one.locate("~/x")).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => one.locate(home)).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("refuses every change under a read-only root, and still reads it", async () => {
    const ro = new Roots({ roots: [{ id: "code", path: ws, mode: "read", stateDir: path.join(base, "state") }] });
    expect(await status(ro.target("src/a.ts"))).toBe("ok");
    expect(await status(ro.creatable("src/new-file"))).toBe(403);
    expect(() => ro.assertMutable(ro.locate("src/a.ts"))).toThrow(expect.objectContaining({ status: 403, code: "read-only" }));
  });

  it("reads a hidden path as missing, and a write-denied one as refused", async () => {
    const real = fs.realpathSync(ws);
    const hiddenDir = path.join(real, "real");
    const guarded = new Roots({
      roots: boxRoots(ws, home),
      isHidden: (p) => p === hiddenDir || p.startsWith(hiddenDir + path.sep),
      isWriteDenied: (p) => p === path.join(real, "src", "a.ts"),
    });
    expect(await status(guarded.target("real"))).toBe(404);
    expect(await status(guarded.target("inside-link"))).toBe(404);
    expect(await status(guarded.entry("real"))).toBe(404);
    expect(await status(guarded.creatable("real/new"))).toBe(404);
    expect(await status(guarded.target("src/a.ts"))).toBe("ok");
    const a = await guarded.entry("src/a.ts");
    expect(() => guarded.assertMutable(a)).toThrow(expect.objectContaining({ status: 403, code: "denied" }));
    expect(await status(guarded.creatable("src/a.ts"))).toBe(403);
  });

  it("compares paths ignoring case when asked to", () => {
    const upper = ws.toUpperCase();
    const ci = new Roots({ roots: boxRoots(ws, home), caseInsensitive: true });
    expect(ci.locate(path.join(upper, "src")).root.id).toBe("workspace");
    const cs = new Roots({ roots: boxRoots(ws, home) });
    expect(() => cs.locate(path.join(upper, "src"))).toThrow(expect.objectContaining({ status: 403 }));
  });
});
