import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { bundleVersion, MAX_BUNDLE, NPM_PACKAGE, npmVersionFor, selfInstall } from "../src/commands/update.js";
import { ConfigStore } from "../src/config.js";
import { EXIT } from "../src/errors.js";
import { filesStub, put, read } from "./files-stub.js";
import { json, runCli, signedIn, stubServer, TOKEN, tmpDir } from "./helpers.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = (p: string): { version: string } => JSON.parse(fs.readFileSync(path.join(pkgDir, p), "utf8")) as { version: string };

let bundle: string;

beforeAll(() => {
  // Built into a folder with no node_modules anywhere above it, and run from
  // there: whatever it needs must be inside it.
  const dir = tmpDir("agentbox-bundle-");
  bundle = path.join(dir, "agentbox.mjs");
  execFileSync(process.execPath, [path.join(pkgDir, "scripts", "build.mjs"), bundle], { stdio: "pipe" });
}, 60_000);

describe("the bundle", () => {
  it("is one executable file that says its version and needs nothing installed", () => {
    const head = fs.readFileSync(bundle, "utf8").split("\n", 2);
    expect(head[0]).toBe("#!/usr/bin/env node");
    expect(bundleVersion(fs.readFileSync(bundle))).toBe(pkg("package.json").version);
    if (process.platform !== "win32") expect(fs.statSync(bundle).mode & 0o111).not.toBe(0);
    const out = spawnSync(process.execPath, [bundle, "--version"], { cwd: path.dirname(bundle), encoding: "utf8" });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout.trim()).toBe(`agentbox ${pkg("package.json").version}`);
    const help = spawnSync(process.execPath, [bundle, "--help"], { encoding: "utf8" });
    expect(help.stdout).toMatch(/Usage: agentbox <command>/);
    const bad = spawnSync(process.execPath, [bundle, "nope"], { encoding: "utf8" });
    expect(bad.status).toBe(EXIT.USAGE);
  });

  it("has ws inside it: a terminal connects from the bundle alone", () => {
    const out = spawnSync(process.execPath, [bundle, "attach", "--box", "none"], {
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: tmpDir() },
    });
    // Not signed in, but the command loaded and ran (ws imported fine).
    expect(out.status).toBe(EXIT.NOT_FOUND);
    expect(out.stderr).toMatch(/no box named "none"/);
  });

  it("moves in step with the gate's version, which the box reports", () => {
    expect(pkg("package.json").version).toBe(pkg("../gate/package.json").version);
  });
});

describe("update", () => {
  it("reads a bundle's version from its banner, and nothing else", () => {
    expect(bundleVersion("#!/usr/bin/env node\n// agentbox-cli 1.2.3\ncode")).toBe("1.2.3");
    expect(bundleVersion("<html>not it</html>")).toBeNull();
    expect(bundleVersion("#!/bin/sh\n// agentbox-cli 1.2.3\n")).toBeNull();
  });

  it("knows a checkout from an installed copy", () => {
    expect(selfInstall(path.join(pkgDir, "src", "cli.ts"))?.checkout).toBe(true);
    const copy = path.join(tmpDir(), "agentbox");
    fs.copyFileSync(bundle, copy);
    expect(selfInstall(copy)).toEqual({ file: fs.realpathSync(copy), checkout: false });
    expect(selfInstall(path.join(tmpDir(), "missing"))).toBeNull();
  });

  it("knows a copy installed from npm, which npm updates", () => {
    // The published package's layout: package.json and dist/agentbox.mjs.
    const root = path.join(tmpDir(), "node_modules", "@jabezpauls", "agentbox");
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.copyFileSync(path.join(pkgDir, "package.json"), path.join(root, "package.json"));
    fs.copyFileSync(bundle, path.join(root, "dist", "agentbox.mjs"));
    const self = selfInstall(path.join(root, "dist", "agentbox.mjs"));
    expect(self).toEqual({ file: fs.realpathSync(path.join(root, "dist", "agentbox.mjs")), checkout: false, npm: true });
    expect(npmVersionFor("v1.4.0")).toBe("1.4.0");
    expect(npmVersionFor("1.4.0-rc.1")).toBe("1.4.0-rc.1");
    expect(npmVersionFor("v1.4.0-3-gabc1234-dirty")).toBe("latest");
    expect(npmVersionFor(null)).toBe("latest");
  });

  it("is published as the package npm installs", () => {
    const p = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
    expect(p.name).toBe(NPM_PACKAGE);
    expect(p.private).toBeUndefined();
    expect(p.bin).toEqual({ agentbox: "dist/agentbox.mjs" });
    expect(p.files).toEqual(["dist/agentbox.mjs"]);
    expect(p.publishConfig).toEqual({ access: "public" });
  });

  it("replaces an installed copy with the box's build, atomically, only if it runs", async () => {
    const served = fs.readFileSync(bundle);
    let body: Buffer = served;
    const box = await stubServer((req, res) => {
      if (req.url === "/cli/agentbox.mjs") {
        // Public: the token is never sent for it.
        if (req.headers.authorization) return json(res, 400, { error: "no token here" });
        res.writeHead(200, { "content-type": "text/javascript" });
        return void res.end(body);
      }
      json(res, 404, {});
    });
    try {
      // As the install script lays it out: the bundle, and a link on PATH to it.
      const dir = tmpDir();
      const installed = path.join(dir, "agentbox.mjs");
      fs.writeFileSync(installed, "#!/usr/bin/env node\n// agentbox-cli 0.0.1\nconsole.log('old');\n", { mode: 0o755 });
      const link = path.join(tmpDir(), "agentbox");
      fs.symlinkSync(installed, link);
      const cfg = signedIn(box.url);
      const argv1 = process.argv[1];
      process.argv[1] = link;
      try {
        const r = await runCli(["update"], { configDir: cfg });
        expect(r.code, r.stderr).toBe(0);
        expect(r.stdout).toMatch(/Updated agentbox .* → /);
        expect(fs.readFileSync(installed).equals(served)).toBe(true);
        expect(fs.readlinkSync(link)).toBe(installed);
        expect(fs.readdirSync(dir)).toEqual(["agentbox.mjs"]);

        const same = await runCli(["update"], { configDir: cfg });
        expect(same.stdout).toMatch(/Already up to date/);

        // A build that does not run is never swapped in.
        body = Buffer.from("#!/usr/bin/env node\n// agentbox-cli 9.9.9\nprocess.exit(3)\n");
        const broken = await runCli(["update"], { configDir: cfg });
        expect(broken.code).toBe(EXIT.FAILURE);
        expect(broken.stderr).toMatch(/does not run here/);
        expect(fs.readFileSync(installed).equals(served)).toBe(true);

        body = Buffer.from("<html>login</html>");
        expect((await runCli(["update"], { configDir: cfg })).stderr).toMatch(/not an agentbox CLI build/);
      } finally {
        process.argv[1] = argv1 as string;
      }
    } finally {
      await box.close();
    }
  });
});

describe("files edit, run for real", () => {
  it.runIf(process.platform !== "win32")("leaves Ctrl-C to the editor, then saves (as git does)", async () => {
    const stub = await filesStub();
    try {
      put(stub, "/workspace/note.txt", "hello\n");
      const xdg = tmpDir();
      new ConfigStore(path.join(xdg, "agentbox")).update((d) => {
        d.boxes.test = { url: stub.url, token: TOKEN, addedAt: 1, versionCheckedAt: Date.now() };
        d.current = "test";
      });
      // The reviewer's editor: it ignores Ctrl-C itself, sends one to its
      // whole process group (as a terminal does), and carries on — for longer
      // than the grace an interrupted command gets before it exits.
      const editor = path.join(tmpDir(), "ed.sh");
      fs.writeFileSync(editor, '#!/bin/sh\ntrap "" INT\nkill -INT 0\nsleep 2\necho edited >> "$1"\nexit 0\n', { mode: 0o755 });
      // A process group of its own, so the Ctrl-C reaches the CLI and the
      // editor and not the test runner.
      const child = spawn(process.execPath, [bundle, "files", "edit", "note.txt"], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, XDG_CONFIG_HOME: xdg, EDITOR: editor, TMPDIR: tmpDir(), HOME: tmpDir() },
      });
      let stderr = "";
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
      expect(code, stderr).toBe(0);
      expect(stderr).toMatch(/Saved \/workspace\/note\.txt/);
      expect(read(stub, "/workspace/note.txt")).toBe("hello\nedited\n");
    } finally {
      await stub.close();
    }
  });
});

describe("update's limits", () => {
  it("refuses a download larger than any build, and a box on plain http elsewhere", async () => {
    const box = await stubServer((req, res) => {
      res.writeHead(200, { "content-type": "text/javascript", "content-length": String(MAX_BUNDLE + 1) });
      res.end();
    });
    const installed = path.join(tmpDir(), "agentbox.mjs");
    fs.copyFileSync(bundle, installed);
    const argv1 = process.argv[1];
    process.argv[1] = installed;
    try {
      const big = await runCli(["update"], { configDir: signedIn(box.url) });
      expect(big.code).toBe(EXIT.FAILURE);
      expect(big.stderr).toMatch(/larger than any CLI build/);
      const far = await runCli(["update"], { configDir: signedIn("http://box.example.invalid") });
      expect(far.code).toBe(EXIT.FAILURE);
      expect(far.stderr).toMatch(/plain http.*--insecure-http/);
      const told = await runCli(["update", "--insecure-http"], { configDir: signedIn("http://box.example.invalid") });
      expect(told.code).toBe(EXIT.UNREACHABLE);
      expect(fs.readFileSync(installed).equals(fs.readFileSync(bundle))).toBe(true);
    } finally {
      process.argv[1] = argv1 as string;
      await box.close();
    }
  });

  it("stops reading a download that grows past the limit without saying its size", async () => {
    const box = await stubServer((req, res) => {
      res.writeHead(200, { "content-type": "text/javascript" });
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      let sent = 0;
      const pump = (): void => {
        while (sent <= MAX_BUNDLE) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      res.write("#!/usr/bin/env node\n// agentbox-cli 9.9.9\n");
      pump();
    });
    const installed = path.join(tmpDir(), "agentbox.mjs");
    fs.copyFileSync(bundle, installed);
    const argv1 = process.argv[1];
    process.argv[1] = installed;
    try {
      const r = await runCli(["update"], { configDir: signedIn(box.url) });
      expect(r.code).toBe(EXIT.FAILURE);
      expect(r.stderr).toMatch(/larger than any CLI build/);
    } finally {
      process.argv[1] = argv1 as string;
      await box.close();
    }
  });
});
