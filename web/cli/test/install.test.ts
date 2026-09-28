import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stubServer, tmpDir, type Stub } from "./helpers.js";

const script = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "install.sh"), "utf8");

let box: Stub;
beforeAll(async () => {
  // A box serving a stand-in CLI: the script only needs it to run.
  box = await stubServer((req, res) => {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end("#!/usr/bin/env node\nconsole.log('agentbox 9.9.9');\n");
  });
});
afterAll(() => box.close());

/** Run the rendered script as `curl … | sh -s -- <args>` would (asynchronously: the box is in this process). */
function install(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const rendered = script.replace("@@AGENTBOX_URL@@", box.url);
  return new Promise((resolve) => {
    const child = spawn("sh", ["-s", "--", ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(rendered);
  });
}

describe.runIf(process.platform !== "win32")("the install script", () => {
  it("gives PATH advice that works for a folder with a quote and a space in its name", async () => {
    const home = tmpDir();
    const dir = path.join(home, "it's my bin");
    const r = await install(["--no-login", "--dir", dir], { HOME: home, SHELL: "/bin/bash" });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readlinkSync(path.join(dir, "agentbox"))).toBe(path.join(home, ".local", "share", "agentbox", "agentbox.mjs"));
    const advice = /^ {2}(echo .* >> ~\/\.bashrc)$/m.exec(r.stdout)?.[1];
    expect(advice, r.stdout).toBeDefined();
    // Pasted as printed, then read by a new shell: the folder is on PATH, whole.
    expect(spawnSync("sh", ["-c", advice as string], { env: { HOME: home, PATH: process.env.PATH ?? "" } }).status).toBe(0);
    const after = spawnSync("sh", ["-c", '. "$HOME/.bashrc"; printf %s "$PATH"'], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(after.stdout.split(":")).toContain(dir);
    // And the sign-in hint names the CLI so it can be pasted too.
    expect(r.stdout).toContain(`Sign in with: '${home}/it'\\''s my bin/agentbox' login ${box.url}`);
  });

  it("quotes the folder for fish, and says nothing about PATH when the folder is on it", async () => {
    const home = tmpDir();
    const dir = path.join(home, "a b");
    const fish = await install(["--no-login", "--dir", dir], { HOME: home, SHELL: "/usr/bin/fish" });
    expect(fish.stdout).toContain(`fish_add_path '${dir}'`);
    const on = await install(["--no-login", "--dir", dir], { HOME: home, SHELL: "/bin/bash", PATH: `${dir}:${process.env.PATH}` });
    expect(on.stdout).not.toMatch(/not on your PATH/);
    expect(on.stdout).toContain(`Sign in with: agentbox login ${box.url}`);
  });

  it("insists on https for every download from an https box, and allows http for a local one", async () => {
    expect(script).toContain("curl -fsSL --proto '=https' --tlsv1.2");
    expect(script).toContain("wget -q --https-only");
    // The box above is http on loopback: it installed without complaint.
    expect((await install(["--no-login", "--dir", path.join(tmpDir(), "bin")], { HOME: tmpDir() })).status).toBe(0);
  });
});
