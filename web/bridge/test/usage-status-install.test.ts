import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `agentbox-status install`, which the entrypoint runs on every start of the
// Workbench's container: it puts the helper in Claude Code's settings, chaining
// to whatever status line was there, and touches nothing else.

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../images/workspace/agentbox-status");

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

function setup(settings?: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "status-install-"));
  homes.push(home);
  const file = path.join(home, ".claude", "settings.json");
  if (settings !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, settings);
  }
  const chain = path.join(home, ".agentbox", "statusline-chain.json");
  const install = (env: Record<string, string> = {}) =>
    execFileSync("node", [CLI, "install"], { env: { PATH: process.env.PATH ?? "", HOME: home, ...env }, stdio: ["ignore", "pipe", "pipe"] }).toString();
  return { home, file, chain, install, read: () => fs.readFileSync(file, "utf8") };
}

const OURS = { type: "command", command: "agentbox-status" };

describe("agentbox-status install", () => {
  it("adds the status line when there is no settings file", () => {
    const s = setup();
    s.install();
    expect(JSON.parse(s.read())).toEqual({ statusLine: OURS });
    expect(fs.existsSync(s.chain)).toBe(false);
  });

  it("adds it beside every other setting, untouched", () => {
    const settings = { model: "opus", permissions: { allow: ["Bash(ls:*)"], deny: [] }, env: { A: "1" }, hooks: {}, n: 1.5 };
    const s = setup(JSON.stringify(settings, null, 2));
    s.install();
    expect(JSON.parse(s.read())).toEqual({ ...settings, statusLine: OURS });
    expect(Object.keys(JSON.parse(s.read()))).toEqual([...Object.keys(settings), "statusLine"]);
  });

  it("chains to the person's own status line, keeping its other settings", () => {
    const theirs = { type: "command", command: "cs --style capsule", refreshInterval: 1, padding: 0 };
    const s = setup(JSON.stringify({ theme: "dark", statusLine: theirs, z: [1, 2] }));
    s.install();
    expect(JSON.parse(s.read())).toEqual({ theme: "dark", statusLine: { ...theirs, command: "agentbox-status" }, z: [1, 2] });
    expect(JSON.parse(fs.readFileSync(s.chain, "utf8"))).toEqual({ command: "cs --style capsule" });
  });

  it("leaves itself alone once installed, chain and all", () => {
    const s = setup(JSON.stringify({ statusLine: { type: "command", command: "cs" } }));
    s.install();
    const settings = s.read();
    const chain = fs.readFileSync(s.chain, "utf8");
    s.install();
    expect(s.read()).toBe(settings);
    expect(fs.readFileSync(s.chain, "utf8")).toBe(chain);
    // However it is spelled.
    const t = setup(JSON.stringify({ statusLine: { type: "command", command: "/usr/local/bin/agentbox-status" } }));
    const before = t.read();
    t.install();
    expect(t.read()).toBe(before);
  });

  it("chains a status line set up since, replacing the old chain", () => {
    const s = setup(JSON.stringify({ statusLine: { type: "command", command: "first" } }));
    s.install();
    fs.writeFileSync(s.file, JSON.stringify({ statusLine: { type: "command", command: "second" } }));
    s.install();
    expect(JSON.parse(fs.readFileSync(s.chain, "utf8"))).toEqual({ command: "second" });
  });

  it("forgets a chain whose status line has since been removed", () => {
    const s = setup(JSON.stringify({ statusLine: { type: "command", command: "first" } }));
    s.install();
    fs.writeFileSync(s.file, JSON.stringify({ other: true }));
    s.install();
    expect(fs.existsSync(s.chain)).toBe(false);
    expect(JSON.parse(s.read())).toEqual({ other: true, statusLine: OURS });
  });

  it("never touches a settings file it cannot parse, and still exits 0", () => {
    for (const text of ["{ \"model\": ", "[1,2]", "null"]) {
      const s = setup(text);
      expect(() => s.install()).not.toThrow();
      expect(s.read()).toBe(text);
    }
  });

  it("leaves a status line that is not a command", () => {
    const text = JSON.stringify({ statusLine: { type: "static", text: "hi" } });
    const s = setup(text);
    s.install();
    expect(s.read()).toBe(text);
  });

  it("follows CLAUDE_CONFIG_DIR", () => {
    const s = setup();
    const dir = path.join(s.home, "elsewhere");
    s.install({ CLAUDE_CONFIG_DIR: dir });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"))).toEqual({ statusLine: OURS });
  });
});
