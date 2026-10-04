import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editorCommand, localName, shellQuote, splitCommand } from "../src/commands/files.js";
import { Progress } from "../src/progress.js";
import { EXIT } from "../src/errors.js";
import { filesStub, link, put, read, type FilesStub } from "./files-stub.js";
import { capture, runCli, signedIn, tmpDir } from "./helpers.js";

const stubs: FilesStub[] = [];
afterEach(async () => {
  while (stubs.length) await stubs.pop()?.close();
});

async function box(): Promise<{ stub: FilesStub; cfg: string; cli: (argv: string[], env?: NodeJS.ProcessEnv) => ReturnType<typeof runCli> }> {
  const stub = await filesStub();
  stubs.push(stub);
  const cfg = signedIn(stub.url);
  return { stub, cfg, cli: (argv, env) => runCli(argv, { configDir: cfg, ...(env ? { env } : {}) }) };
}

describe("files ls and stat", () => {
  it("lists a folder across pages, folders first, and as JSON", async () => {
    const { stub, cli } = await box();
    put(stub, "/workspace/proj", null);
    put(stub, "/workspace/a.txt", "hello");
    put(stub, "/workspace/b.txt", "world!");
    put(stub, "/workspace/.hidden", "x");
    const human = await cli(["files", "ls"]);
    expect(human.code, human.stderr).toBe(0);
    const lines = human.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/SIZE\s+MODIFIED\s+NAME/);
    expect(lines.slice(1).map((l) => l.split(/\s+/).at(-1))).toEqual(["proj/", "a.txt", "b.txt"]);
    const asJson = JSON.parse((await cli(["files", "ls", "--json", "-a", "/workspace"])).stdout) as { total: number; entries: Array<{ name: string }> };
    expect(asJson.total).toBe(4);
    expect(asJson.entries.map((e) => e.name)).toEqual(["proj", ".hidden", "a.txt", "b.txt"]);
  });

  it("shows a file when given one, and says when there is nothing", async () => {
    const { stub, cli } = await box();
    put(stub, "/workspace/a.txt", "hello");
    const one = await cli(["files", "ls", "a.txt"]);
    expect(one.stdout).toMatch(/5 B .* a\.txt/);
    const stat = JSON.parse((await cli(["files", "stat", "--json", "a.txt"])).stdout);
    expect(stat).toMatchObject({ path: "/workspace/a.txt", type: "file", size: 5 });
    const missing = await cli(["files", "stat", "nope"]);
    expect(missing.code).toBe(EXIT.NOT_FOUND);
  });

  it("makes control characters in names visible instead of sending them to the terminal", async () => {
    const { stub, cli } = await box();
    put(stub, "/workspace/evil\u001b]0;pwned\u0007.txt", "x");
    const r = await cli(["files", "ls"]);
    expect(r.stdout).not.toContain("\u001b");
    expect(r.stdout).toContain("evil\\x1b]0;pwned\\x07.txt");
  });
});

describe("files put and get", () => {
  it("puts a file into a folder, refuses to replace it without --force, and gets it back", async () => {
    const { stub, cli } = await box();
    const dir = tmpDir();
    const src = path.join(dir, "notes.md");
    fs.writeFileSync(src, "# notes\n");
    put(stub, "/workspace/proj", null);
    expect((await cli(["files", "put", src, "proj"])).code).toBe(0);
    expect(read(stub, "/workspace/proj/notes.md")).toBe("# notes\n");

    const again = await cli(["files", "put", src, "proj"]);
    expect(again.code).toBe(EXIT.FAILURE);
    expect(again.stderr).toMatch(/already exists; add --force/);
    fs.writeFileSync(src, "# changed\n");
    expect((await cli(["files", "put", "--force", src, "proj/notes.md"])).code).toBe(0);
    expect(read(stub, "/workspace/proj/notes.md")).toBe("# changed\n");

    const out = tmpDir();
    const got = await cli(["files", "get", "proj/notes.md", out]);
    expect(got.code, got.stderr).toBe(0);
    expect(fs.readFileSync(path.join(out, "notes.md"), "utf8")).toBe("# changed\n");
    const toFile = path.join(out, "renamed.md");
    expect((await cli(["files", "get", "proj/notes.md", toFile])).code).toBe(0);
    expect(fs.readFileSync(toFile, "utf8")).toBe("# changed\n");
  });

  it("puts a folder with -r (into /workspace by default), and gets it back with -r", async () => {
    const { stub, cli } = await box();
    const dir = tmpDir();
    const tree = path.join(dir, "data");
    fs.mkdirSync(path.join(tree, "sub", "deeper"), { recursive: true });
    fs.writeFileSync(path.join(tree, "a.txt"), "alpha");
    fs.writeFileSync(path.join(tree, "sub", "deeper", "c.txt"), "deep");
    fs.writeFileSync(path.join(tree, ".dot"), "dot");

    const noR = await cli(["files", "put", tree]);
    expect(noR.code).toBe(EXIT.FAILURE);
    expect(noR.stderr).toMatch(/add -r/);
    const r = await cli(["files", "put", tree, "-r", "--chunk-size", "1K"]);
    expect(r.code, r.stderr).toBe(0);
    expect(read(stub, "/workspace/data/a.txt")).toBe("alpha");
    expect(read(stub, "/workspace/data/sub/deeper/c.txt")).toBe("deep");
    expect(read(stub, "/workspace/data/.dot")).toBe("dot");

    const out = tmpDir();
    const got = await cli(["files", "get", "-r", "data", out]);
    expect(got.code, got.stderr).toBe(0);
    expect(fs.readFileSync(path.join(out, "data", "sub", "deeper", "c.txt"), "utf8")).toBe("deep");
    expect(fs.readFileSync(path.join(out, "data", ".dot"), "utf8")).toBe("dot");
  });

  it("makes a folder for a destination ending in /, and refuses several sources into a non-folder", async () => {
    const { stub, cli } = await box();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "x"), "x");
    fs.writeFileSync(path.join(dir, "y"), "y");
    expect((await cli(["files", "put", path.join(dir, "x"), path.join(dir, "y"), "new/"])).code).toBe(0);
    expect(read(stub, "/workspace/new/x")).toBe("x");
    expect(read(stub, "/workspace/new/y")).toBe("y");
    const bad = await cli(["files", "put", path.join(dir, "x"), path.join(dir, "y"), "new/x"]);
    expect(bad.code).toBe(EXIT.FAILURE);
    expect(bad.stderr).toMatch(/not a folder on the box/);
  });

  it("cats files to stdout, and gets one to stdout with -", async () => {
    const { stub, cli } = await box();
    put(stub, "/workspace/a.txt", "one\n");
    put(stub, "/workspace/b.txt", "two\n");
    expect((await cli(["files", "cat", "a.txt", "b.txt"])).stdout).toBe("one\ntwo\n");
    expect((await cli(["files", "get", "a.txt", "-"])).stdout).toBe("one\n");
  });
});

describe("files rm, mv, cp and mkdir", () => {
  it("trashes, needing -r for a folder", async () => {
    const { stub, cli } = await box();
    put(stub, "/workspace/a.txt", "a");
    put(stub, "/workspace/dir", null);
    put(stub, "/workspace/dir/in.txt", "in");
    expect((await cli(["files", "rm", "a.txt"])).code).toBe(0);
    expect(stub.trashed).toEqual(["/workspace/a.txt"]);
    const noR = await cli(["files", "rm", "dir"]);
    expect(noR.code).toBe(EXIT.FAILURE);
    expect((await cli(["files", "rm", "-r", "dir"])).code).toBe(0);
    expect(stub.fs.has("/workspace/dir/in.txt")).toBe(false);
    expect((await cli(["files", "rm", "gone"])).code).toBe(EXIT.NOT_FOUND);
    expect((await cli(["files", "rm", "-f", "gone"])).code).toBe(0);
  });

  it("moves and copies into a folder or to a new name", async () => {
    const { stub, cli } = await box();
    put(stub, "/workspace/a.txt", "a");
    put(stub, "/workspace/dest", null);
    expect((await cli(["files", "mv", "a.txt", "dest"])).code).toBe(0);
    expect(read(stub, "/workspace/dest/a.txt")).toBe("a");
    expect((await cli(["files", "cp", "dest/a.txt", "b.txt"])).code).toBe(0);
    expect(read(stub, "/workspace/b.txt")).toBe("a");
    const clash = await cli(["files", "cp", "dest/a.txt", "b.txt"]);
    expect(clash.stderr).toMatch(/add --force/);
    expect((await cli(["files", "cp", "-f", "dest/a.txt", "b.txt"])).code).toBe(0);
    const dirNoR = await cli(["files", "cp", "dest", "copy"]);
    expect(dirNoR.stderr).toMatch(/add -r/);
    expect((await cli(["files", "cp", "-r", "dest", "copy"])).code).toBe(0);
    expect(read(stub, "/workspace/copy/a.txt")).toBe("a");
  });

  it("makes folders with their parents", async () => {
    const { stub, cli } = await box();
    expect((await cli(["files", "mkdir", "-p", "a/b/c"])).code).toBe(0);
    expect(stub.fs.get("/workspace/a/b/c")?.type).toBe("dir");
  });
});

describe("files edit", () => {
  const editor = (script: string): string => {
    const file = path.join(tmpDir(), "editor.sh");
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return file;
  };

  it.runIf(process.platform !== "win32")("round-trips through $EDITOR and saves with overwrite", async () => {
    const { stub, cli } = await box();
    put(stub, "/workspace/conf.txt", "port=1\n");
    const r = await cli(["files", "edit", "conf.txt"], { EDITOR: editor(`sed -i.bak 's/port=1/port=2/' "$1"`) });
    expect(r.code, r.stderr).toBe(0);
    expect(read(stub, "/workspace/conf.txt")).toBe("port=2\n");
    expect(stub.writes).toEqual([{ path: "/workspace/conf.txt", overwrite: true }]);
  });

  it.runIf(process.platform !== "win32")("saves nothing when nothing changed, or the editor failed", async () => {
    const { stub, cli } = await box();
    put(stub, "/workspace/conf.txt", "same\n");
    expect((await cli(["files", "edit", "conf.txt"], { EDITOR: "true" })).stderr).toMatch(/No changes/);
    const failed = await cli(["files", "edit", "conf.txt"], { EDITOR: editor(`echo x >> "$1"; exit 3`) });
    expect(failed.code).toBe(EXIT.FAILURE);
    expect(failed.stderr).toMatch(/exited with code 3; nothing was saved/);
    expect(stub.writes).toEqual([]);
  });

  it.runIf(process.platform !== "win32")("creates a new file, and passes an $EDITOR with arguments through a shell", async () => {
    const { stub, cli } = await box();
    const ed = editor(`printf '%s\\n' "$2" > "$1"`);
    const r = await cli(["files", "edit", "new.txt"], { VISUAL: `${ed} "$1" 'made by edit'` });
    expect(r.code, r.stderr).toBe(0);
    expect(read(stub, "/workspace/new.txt")).toBe("made by edit\n");
    expect(stub.writes).toEqual([{ path: "/workspace/new.txt", overwrite: false }]);
  });

  it.runIf(process.platform !== "win32")("edits what a link points at, and leaves the link a link", async () => {
    const { stub, cli } = await box();
    put(stub, "/workspace/real", null);
    put(stub, "/workspace/real/conf.txt", "port=1\n");
    link(stub, "/workspace/conf.txt", "real/conf.txt");
    link(stub, "/workspace/out.txt", "/etc/passwd");
    const r = await cli(["files", "edit", "conf.txt"], { EDITOR: editor(`sed -i.bak 's/port=1/port=2/' "$1"`) });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/is a link: editing \/workspace\/real\/conf\.txt/);
    expect(read(stub, "/workspace/real/conf.txt")).toBe("port=2\n");
    expect(stub.fs.get("/workspace/conf.txt")?.type).toBe("symlink");
    const out = await cli(["files", "edit", "out.txt"], { EDITOR: "true" });
    expect(out.code).toBe(EXIT.FAILURE);
    expect(out.stderr).toMatch(/a link to something outside the workspace, or nothing; edit what it points at/);
  });

  it.runIf(process.platform !== "win32")("refuses to overwrite a file that changed on the box meanwhile", async () => {
    const { stub, cli } = await box();
    put(stub, "/workspace/conf.txt", "v1\n");
    // The "editor" changes the file, and while it is open so does someone on
    // the box; it closes only once they have.
    const sync = tmpDir();
    const ed = editor(`echo mine > "$1"; touch '${sync}/editing'; while [ ! -f '${sync}/changed' ]; do sleep 0.02; done`);
    const run = cli(["files", "edit", "conf.txt"], { EDITOR: ed });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(sync, "editing")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    put(stub, "/workspace/conf.txt", "theirs, longer\n");
    fs.writeFileSync(path.join(sync, "changed"), "");
    const r = await run;
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.stderr).toMatch(/changed on the box while you were editing/);
    // The command to save it anyway, quoted to paste as it stands.
    expect(r.stderr).toMatch(/agentbox files put --force '\/[^']+\/conf\.txt' '\/workspace\/conf\.txt'/);
    expect(read(stub, "/workspace/conf.txt")).toBe("theirs, longer\n");
  });
});

describe("local names", () => {
  it("never become paths", () => {
    expect(localName("a/b", "linux")).toBe("a_b");
    expect(localName("..", "linux")).toBe("__");
    expect(localName("con:x?.txt", "win32")).toBe("con_x_.txt");
    expect(localName("trailing. ", "win32")).toBe("trailing_");
    expect(localName("normal.txt", "win32")).toBe("normal.txt");
  });

  it("never name a Windows device", () => {
    for (const n of ["CON", "con.txt", "NUL", "nul.tar.gz", "Aux", "PRN.md", "COM1", "lpt9.log", "COM¹"]) {
      expect(localName(n, "win32"), n).toBe(`_${n}`);
    }
    for (const n of ["console.txt", "nullable", "com10", "CON"]) {
      if (n === "CON") expect(localName(n, "linux")).toBe("CON");
      else expect(localName(n, "win32"), n).toBe(n);
    }
  });
});

describe("put -r and symbolic links", () => {
  it.runIf(process.platform !== "win32")("never follows a link out of the folder unless -L, and says what it skipped", async () => {
    const { stub, cli } = await box();
    const home = tmpDir();
    fs.writeFileSync(path.join(home, "secret.txt"), "TOP-SECRET-LOCAL-KEY\n");
    fs.mkdirSync(path.join(home, "outside-dir"));
    fs.writeFileSync(path.join(home, "outside-dir", "x.txt"), "x");
    const proj = path.join(home, "proj");
    fs.mkdirSync(path.join(proj, "sub"), { recursive: true });
    fs.writeFileSync(path.join(proj, "README"), "readme\n");
    fs.writeFileSync(path.join(proj, "sub", "inner.txt"), "inner\n");
    // The reviewer's repro: an innocent-looking link to a file outside.
    fs.symlinkSync(path.join(home, "secret.txt"), path.join(proj, "innocent.txt"));
    fs.symlinkSync(path.join(home, "outside-dir"), path.join(proj, "outlink"));
    fs.symlinkSync("sub/inner.txt", path.join(proj, "inside-file"));
    fs.symlinkSync("sub", path.join(proj, "inside-dir"));
    fs.symlinkSync("..", path.join(proj, "sub", "up"));
    fs.symlinkSync("nowhere", path.join(proj, "dangling"));

    const r = await cli(["files", "put", "-r", proj]);
    expect(r.code, r.stderr).toBe(0);
    expect(read(stub, "/workspace/proj/README")).toBe("readme\n");
    expect(read(stub, "/workspace/proj/inside-file")).toBe("inner\n");
    expect(stub.fs.has("/workspace/proj/innocent.txt")).toBe(false);
    expect(stub.fs.has("/workspace/proj/outlink")).toBe(false);
    expect(stub.fs.has("/workspace/proj/inside-dir")).toBe(false);
    for (const b of stub.uploads.values()) expect(b.data.toString()).not.toContain("TOP-SECRET");
    expect(r.stderr).toMatch(/skipped .*innocent\.txt: a link out of .*add -L/);
    expect(r.stderr).toMatch(/skipped .*outlink: a link out of/);
    expect(r.stderr).toMatch(/skipped .*inside-dir: a link to a folder; add -L/);
    expect(r.stderr).toMatch(/skipped .*dangling: a link to nothing/);

    const followed = await cli(["files", "put", "-r", "-L", "--force", proj, "copy"]);
    expect(followed.code, followed.stderr).toBe(0);
    expect(read(stub, "/workspace/copy/innocent.txt")).toBe("TOP-SECRET-LOCAL-KEY\n");
    expect(read(stub, "/workspace/copy/outlink/x.txt")).toBe("x");
    expect(read(stub, "/workspace/copy/inside-dir/inner.txt")).toBe("inner\n");
    // A link back up is followed once around, not for ever.
    expect(followed.stderr).toMatch(/skipped .*up: it leads back to a folder above it/);
  });
});

describe("safety of what reaches the terminal", () => {
  it("escapes names from the box in the progress line, and copes with a 0-column terminal", () => {
    const err = capture({ isTTY: true, columns: 0 });
    const p = new Progress(err, "dl/\x1b]0;PWNED\x07\x1b[31mred", 10, true, () => 0);
    p.update(5);
    p.finish();
    const text = err.text();
    expect(text).not.toContain("\x1b]0;");
    expect(text).toContain("\\x1b]0;PWNED\\x07");
    for (const cols of [0, 1, 5, 19]) {
      const s = capture({ isTTY: true, columns: cols });
      new Progress(s, "a-rather-long-label-for-a-narrow-terminal.bin", 1000, true, () => 0).finish();
      expect(s.text().replace(/\r\x1b\[2K/, "").trimEnd().length, String(cols)).toBeLessThanOrEqual(80);
    }
  });

  it("escapes what the box says about a file, and survives a nonsense mtime", async () => {
    const { stub, cli } = await box();
    stub.fs.set("/workspace/odd", { type: "file", data: Buffer.from("x"), mtime: Number.NaN });
    const r = await cli(["files", "stat", "odd"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/modified {2}-/);
  });

  it("gets into a missing local folder with a plain error, not a stack trace", async () => {
    const { stub, cli } = await box();
    put(stub, "/workspace/a.txt", "a");
    const r = await cli(["files", "get", "a.txt", path.join(tmpDir(), "no", "such", "a.txt")]);
    expect(r.code).toBe(EXIT.NOT_FOUND);
    expect(r.stderr).toMatch(/no such folder here/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});

describe("the editor, on Windows", () => {
  it("runs an .exe without a shell, and a .cmd through cmd.exe only with a plain path", () => {
    const bin = tmpDir();
    fs.writeFileSync(path.join(bin, "notepad.exe"), "", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "code.cmd"), "", { mode: 0o755 });
    const env = { PATH: bin, PATHEXT: ".EXE;.CMD" };
    expect(splitCommand('"C:\\Program Files\\Ed\\ed.exe" --wait -n')).toEqual(["C:\\Program Files\\Ed\\ed.exe", "--wait", "-n"]);
    expect(editorCommand("notepad", "C:\\T\\a&b.txt", "win32", env)).toEqual({ command: path.join(bin, "notepad.exe"), args: ["C:\\T\\a&b.txt"], shell: false });
    const code = editorCommand("code --wait", "C:\\Temp\\agentbox-edit-x\\conf.txt", "win32", env);
    expect(code.shell).toBe(true);
    expect(code.command).toBe(`"${path.join(bin, "code.cmd")}" "--wait" "C:\\Temp\\agentbox-edit-x\\conf.txt"`);
    expect(() => editorCommand("code --wait", "C:\\T&calc\\conf.txt", "win32", env)).toThrow(/cmd.exe would act on/);
    // Elsewhere: sh -c with the file as its own argument, never in the command.
    expect(editorCommand("code --wait", "/tmp/a'b", "linux")).toEqual({ command: "/bin/sh", args: ["-c", 'trap : INT QUIT; code --wait "$@"', "sh", "/tmp/a'b"], shell: false });
  });

  it("quotes a path for pasting into either shell", () => {
    expect(shellQuote("/tmp/it's here", "linux")).toBe("'/tmp/it'\\''s here'");
    expect(shellQuote('C:\\a "b"', "win32")).toBe('"C:\\a ""b"""');
  });
});
