import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { bundleVersion, selfInstall } from "../src/commands/update.js";
import { EXIT } from "../src/errors.js";
import { json, runCli, signedIn, stubServer, tmpDir } from "./helpers.js";

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
