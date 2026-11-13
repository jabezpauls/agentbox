import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { claudePaths, shimText } from "../src/node/claude.js";
import { pathRules, toApiPath, toHostPath } from "../src/node/files.js";
import { herdrAddress } from "../src/node/herdr.js";
import { HERDR_WINDOWS, herdrPath, sha256, unpackVerified } from "../src/node/install.js";
import { WINDOWS_NOTES } from "../src/node/join.js";
import { nodePaths } from "../src/node/paths.js";
import { parsePolicy, summarize } from "../src/node/policy.js";
import { writePreviewShim } from "../src/node/preview.js";
import { withPath, writeShellShim } from "../src/node/proc.js";
import { guiExecutable, RotatingLog, runCommandLine, runEntry, supervise } from "../src/node/service-windows.js";
import { unzip } from "../src/node/unzip.js";
import { tmpDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** A zip of `files` (deflated; CRCs left 0, which the node does not read). */
function zipOf(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content);
    const data = deflateRawSync(raw);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

describe("every child the node starts has no window", () => {
  // A child of the windowless node without windowsHide gets a visible console
  // window (machines spike, question 4): every spawn in the node's code says so.
  const sources = [
    ...fs.readdirSync(path.join(here, "../src/node")).map((f) => path.join(here, "../src/node", f)),
    path.join(here, "../src/commands/node.ts"),
    ...["files", "herdr", "link"].flatMap((d) => fs.readdirSync(path.join(here, "../../hostcore/src", d)).map((f) => path.join(here, "../../hostcore/src", d, f))),
  ].filter((f) => f.endsWith(".ts"));

  /** Each call of a child_process function, with its arguments' text. */
  function calls(text: string): string[] {
    const out: string[] = [];
    const re = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      // Not a method of something else (`re.exec(`), and not this file's own definition.
      const before = text.slice(Math.max(0, m.index - 1), m.index);
      if (before === "." || /function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index)) || /private\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
      let depth = 0;
      let i = m.index + m[0].length - 1;
      for (; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")" && --depth === 0) break;
      }
      out.push(text.slice(m.index, i + 1));
    }
    return out;
  }

  it("finds the spawns it checks", () => {
    const all = sources.flatMap((f) => calls(fs.readFileSync(f, "utf8")));
    expect(all.length).toBeGreaterThan(8);
  });

  for (const file of sources) {
    it(path.relative(path.join(here, "../.."), file), () => {
      for (const call of calls(fs.readFileSync(file, "utf8"))) expect(call, call.slice(0, 120)).toMatch(/windowsHide: true/);
    });
  }
});

describe("paths on a Windows machine", () => {
  it("are /-style in the API, drives as roots", () => {
    expect(toApiPath("C:\\Users\\o\\code", "win32")).toBe("/C:/Users/o/code");
    expect(toApiPath("D:\\", "win32")).toBe("/D:");
    expect(toApiPath("d:\\data\\", "win32")).toBe("/d:/data");
    expect(toApiPath("/home/o", "linux")).toBe("/home/o");
    expect(toHostPath("/C:/Users/o/code", "win32")).toBe("C:\\Users\\o\\code");
    expect(toHostPath("/D:", "win32")).toBe("D:\\");
    expect(toHostPath("/D:/", "win32")).toBe("D:\\");
    expect(toHostPath("C:\\x", "win32")).toBe("C:\\x");
    expect(toHostPath("~/code", "win32")).toBe("~/code");
    // Still what they were: refused below as UNC, device and stream paths.
    expect(toHostPath("//server/share/x", "win32")).toBe("\\\\server\\share\\x");
    expect(toHostPath("//?/C:/x", "win32")).toBe("\\\\?\\C:\\x");
    for (const p of ["C:\\Users\\o\\a b.txt", "E:\\"]) expect(toHostPath(toApiPath(p, "win32"), "win32")).toBe(p);
  });

  const home = "C:\\Users\\o";
  const nodeDir = "C:\\Users\\o\\AppData\\Local\\agentbox\\node";
  const env = {
    APPDATA: "C:\\Users\\o\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\o\\AppData\\Local",
    OneDrive: "C:\\Users\\o\\OneDrive",
    Path: "C:\\Windows\\system32;C:\\Users\\o\\AppData\\Local\\Microsoft\\WindowsApps",
  };
  const rules = pathRules({ home, nodeDir, env, platform: "win32", resolve: false, documents: ["D:\\Docs"] });

  it("hide the credential stores and browser profiles, case-insensitively", () => {
    for (const p of [
      "C:\\Users\\o\\AppData\\Roaming\\Microsoft\\Credentials\\x",
      "c:\\users\\O\\appdata\\local\\microsoft\\credentials",
      "C:\\Users\\o\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies",
      "C:\\Users\\o\\AppData\\Local\\Microsoft\\Edge\\User Data",
      "C:\\Users\\o\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles",
      `${nodeDir}\\credentials.json`,
      `${nodeDir}\\control.pipe`,
      "C:\\Users\\o\\.ssh\\id_ed25519",
    ]) {
      expect(rules.isHidden(p), p).toBe(true);
    }
    expect(rules.isHidden("C:\\Users\\o\\code\\a.txt")).toBe(false);
    // A junction that resolves to a network share: never shown or written.
    expect(rules.isHidden("\\\\server\\share\\x")).toBe(true);
    expect(rules.isWriteDenied("\\\\?\\UNC\\server\\share\\x")).toBe(true);
  });

  it("deny writes to PowerShell's profiles wherever Documents is, Startup, the node, and PATH", () => {
    for (const p of [
      "C:\\Users\\o\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1",
      "C:\\Users\\o\\Documents\\WindowsPowerShell\\profile.ps1",
      "C:\\Users\\o\\OneDrive\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1",
      "D:\\Docs\\WindowsPowerShell\\profile.ps1",
      "C:\\Users\\o\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.lnk",
      `${nodeDir}\\policy.json`,
      "C:\\Users\\o\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
      "C:\\Users\\o\\.gitconfig",
      "C:\\Users\\o\\code\\.git\\hooks\\pre-commit",
    ]) {
      expect(rules.isWriteDenied(p), p).toBe(true);
    }
    expect(rules.isWriteDenied("C:\\Users\\o\\Documents\\notes.txt")).toBe(false);
  });

  it("refuse UNC, device and stream paths, and names Windows would change", () => {
    for (const p of ["\\\\server\\share", "\\\\?\\C:\\x", "\\\\.\\pipe\\x", "C:\\code\\a.txt:secret", "C:\\code\\a.txt::$DATA", "C:\\code\\.bashrc.", "C:\\code\\x ", "C:\\code\\nul.txt", "C:\\code\\COM1"]) {
      expect(rules.refusePath(p), p).not.toBeNull();
    }
    for (const p of ["C:\\code\\a.txt", "C:\\code\\a b\\c.d", "D:\\"]) expect(rules.refusePath(p), p).toBeNull();
  });

  it("take a drive as a folder in policy.json, never a network share, and report them /-style", () => {
    const ok = parsePolicy(JSON.stringify({ files: [{ path: "D:\\", mode: "read" }, { path: "~\\code", mode: "write" }] }), home, "win32");
    expect(ok.problem).toBeNull();
    expect(ok.policy.files).toEqual([
      { path: "D:\\", mode: "read" },
      { path: "C:\\Users\\o\\code", mode: "write" },
    ]);
    expect(summarize(ok, "win32").files.map((f) => f.path)).toEqual(["/D:", "/C:/Users/o/code"]);
    for (const p of ["\\\\server\\share\\code", "\\\\?\\C:\\code", "\\code"]) {
      expect(parsePolicy(JSON.stringify({ files: [{ path: p, mode: "read" }] }), home, "win32").problem, p).not.toBeNull();
    }
  });
});

describe("herdr on Windows", () => {
  it("is reached at \\\\.\\pipe\\ and its socket path, verbatim", () => {
    expect(herdrAddress("C:\\Users\\o\\AppData\\Local\\agentbox\\node\\herdr-0a1b2c3d.sock", "win32")).toBe("\\\\.\\pipe\\C:\\Users\\o\\AppData\\Local\\agentbox\\node\\herdr-0a1b2c3d.sock");
    expect(herdrAddress("/x/herdr.sock", "linux")).toBe("/x/herdr.sock");
    expect(herdrPath("C:\\n\\bin", "win32").endsWith(`herdr${path.sep}herdr.exe`)).toBe(true);
  });

  it("pins what scripts/machines-manifest.mjs pins", () => {
    const script = fs.readFileSync(path.join(here, "../scripts/machines-manifest.mjs"), "utf8");
    const block = /const HERDR_WINDOWS = \{([\s\S]*?)\n\};/.exec(script)?.[1] ?? "";
    expect(block).toContain(`sha256: "${HERDR_WINDOWS.sha256}"`);
    expect(block).toContain(`size: ${HERDR_WINDOWS.size}`);
    for (const [name, digest] of Object.entries(HERDR_WINDOWS.files)) expect(block).toContain(`"${name}": "${digest}"`);
    expect(Object.keys(HERDR_WINDOWS.files)).toHaveLength(5);
  });

  it("unpacks only the pinned files, each verified, and nothing when one is wrong", () => {
    const files = { "herdr.exe": "exe bytes", "conpty/conpty.dll": "dll bytes" };
    const pins = Object.fromEntries(Object.entries(files).map(([n, c]) => [n, sha256(Buffer.from(c))]));
    const zip = zipOf({ ...files, "THIRD-PARTY-NOTICES/a.txt": "notices" });
    expect([...unzip(zip).keys()]).toEqual(["herdr.exe", "conpty/conpty.dll", "THIRD-PARTY-NOTICES/a.txt"]);
    const dir = tmpDir();
    unpackVerified(zip, pins, dir, "herdr");
    expect(fs.readFileSync(path.join(dir, "conpty", "conpty.dll"), "utf8")).toBe("dll bytes");
    expect(fs.existsSync(path.join(dir, "THIRD-PARTY-NOTICES"))).toBe(false);
    // Replaced over a "running" one, as Windows allows: moved aside first.
    unpackVerified(zip, pins, dir, "herdr", "win32");
    expect(fs.existsSync(path.join(dir, "herdr.exe.old"))).toBe(true);

    const bad = tmpDir();
    expect(() => unpackVerified(zipOf({ ...files, "herdr.exe": "other bytes" }), pins, bad, "herdr")).toThrow(/herdr.exe failed verification/);
    expect(fs.readdirSync(bad)).toEqual([]);
    expect(() => unpackVerified(zipOf({ "conpty/conpty.dll": "dll bytes" }), pins, bad, "herdr")).toThrow(/has no herdr.exe/);
    expect(() => unzip(zipOf({ "../evil.exe": "x" }))).toThrow(/outside itself/);
    expect(() => unzip(Buffer.from("not a zip at all, not at all"))).toThrow(/not a zip/);
  });
});

describe("the node's shims and service on Windows", () => {
  it("writes claude.cmd and agentbox-preview.cmd", () => {
    const p = nodePaths("C:\\n", "win32");
    expect(p.control.endsWith("control.pipe")).toBe(true);
    const c = claudePaths(p, "win32");
    expect(c.shim.endsWith("claude.cmd")).toBe(true);
    const text = shimText(c, "win32");
    expect(text).toMatch(/^@echo off\r\n/);
    expect(text).toContain("set /p CLAUDE_CODE_OAUTH_TOKEN=<");
    expect(text).toContain('set "DISABLE_UPDATES=1"');
    expect(text).toContain("--append-system-prompt-file");
    expect(text).toContain(`if /i "%~1"=="%%a" goto plain`);
    const dir = tmpDir();
    const file = writePreviewShim(dir, ["C:\\Program Files\\agentbox\\agentbox.exe"], "win32");
    expect(path.basename(file)).toBe("agentbox-preview.cmd");
    expect(fs.readFileSync(file, "utf8")).toContain('"C:\\Program Files\\agentbox\\agentbox.exe" node preview %*');
  });

  it("puts its folders first on one PATH, however Windows spelled it", () => {
    const env = withPath({ Path: "C:\\Windows", PATH: "C:\\dup", other: "x" }, ["C:\\n\\shims"], "win32");
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "PATH")).toEqual(["Path"]);
    expect(env.Path).toBe("C:\\n\\shims;C:\\Windows");
    expect(withPath({ PATH: "/usr/bin" }, ["/n/shims"], "linux").PATH).toBe("/n/shims:/usr/bin");
    // herdr's panes get Windows' PATH from the registry: their shell puts the folders back.
    const dir = tmpDir();
    const shell = writeShellShim(dir, ["C:\\n\\shims", "C:\\100%\\bin"], "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(path.basename(shell)).toBe("agentbox-shell.cmd");
    expect(fs.readFileSync(shell, "utf8").split("\r\n")).toEqual([
      "@echo off",
      expect.stringMatching(/^rem /),
      'set "SHELL="',
      'set "Path=C:\\n\\shims;C:\\100%%\\bin;%Path%"',
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo',
      "",
    ]);
  });

  it("registers only the standalone executable, starting node supervise without a window", () => {
    expect(guiExecutable("/usr/bin/node", "/opt/agentbox.mjs")).toMatchObject({ problem: expect.stringMatching(/standalone/) });
    expect(runEntry("C:\\a b\\agentbox-node.exe")).toBe('"C:\\a b\\agentbox-node.exe" node supervise');
    expect(runCommandLine("/x/agentbox-node.exe", "/x/agentbox-node.exe")).toEqual([path.join("/x", "agentbox.exe"), "node", "run"]);
    expect(runCommandLine("/usr/bin/node", "/opt/agentbox.mjs")).toEqual(["/usr/bin/node", path.resolve("/opt/agentbox.mjs"), "node", "run"]);
    expect(WINDOWS_NOTES).toMatch(/other people also sign in/);
    expect(WINDOWS_NOTES).toMatch(/Smart App Control/);
  });

  it("rotates its log at the size, keeping three files", () => {
    const dir = tmpDir();
    const file = path.join(dir, "node.log");
    const log = new RotatingLog(file, 100, 3);
    for (let i = 0; i < 10; i++) log.write(`${String(i).repeat(40)}\n`);
    expect(fs.readdirSync(dir).sort()).toEqual(["node.log", "node.log.1", "node.log.2"]);
    for (const f of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, f)).size).toBeLessThanOrEqual(100);
    expect(fs.readFileSync(file, "utf8")).toContain("9999");
  });

  it("supervises: restarts a failing node with backoff, and stops when it exits 0", async () => {
    const dir = tmpDir();
    const p = nodePaths(dir);
    const count = path.join(dir, "runs");
    // Fails twice, then exits 0 (as a node that left does).
    const script = `const fs=require("fs");const n=Number(fs.existsSync(${JSON.stringify(count)})?fs.readFileSync(${JSON.stringify(count)},"utf8"):0)+1;fs.writeFileSync(${JSON.stringify(count)},String(n));console.log("run "+n);process.exit(n<3?1:0)`;
    const code = await supervise({ paths: p, command: [process.execPath, "-e", script], minBackoffMs: 10, maxBackoffMs: 20 });
    expect(code).toBe(0);
    expect(fs.readFileSync(count, "utf8")).toBe("3");
    const log = fs.readFileSync(path.join(p.state, "node.log"), "utf8");
    expect(log).toMatch(/run 1\n[\s\S]*restarting in[\s\S]*run 3\n[\s\S]*not restarting it/);
    expect(fs.existsSync(path.join(p.state, "supervise.json"))).toBe(false);
  });
});
