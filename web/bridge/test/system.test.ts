import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SystemInfo } from "@workbench/shared";
import {
  parseCpuMax,
  parseKeyed,
  parseLimit,
  parseProcStat,
  SystemMonitor,
  versionIn,
} from "../src/system.js";
import { loadConfig } from "../src/config.js";
import { filesFixture, tmpBase } from "./helpers/files.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (p: string) => fs.readFileSync(path.join(fixtures, p), "utf8");

describe("parsing cgroup v2 and /proc", () => {
  it("reads a CPU limit, or none", () => {
    expect(parseCpuMax(read("cgroup/limited/cpu.max"))).toBe(2);
    expect(parseCpuMax(read("cgroup/unlimited/cpu.max"))).toBeNull();
    expect(parseCpuMax("50000 100000")).toBe(0.5);
  });

  it("reads memory and pid limits, or none", () => {
    expect(parseLimit(read("cgroup/limited/memory.max"))).toBe(4 * 1024 ** 3);
    expect(parseLimit(read("cgroup/unlimited/memory.max"))).toBeNull();
    expect(parseLimit(read("cgroup/limited/pids.max"))).toBe(512);
    expect(parseLimit(read("cgroup/unlimited/pids.max"))).toBeNull();
  });

  it("reads keyed stat files", () => {
    const cpu = parseKeyed(read("cgroup/limited/cpu.stat"));
    expect(cpu.get("usage_usec")).toBe(5_000_000);
    expect(parseKeyed(read("cgroup/limited/memory.stat")).get("inactive_file")).toBe(268_435_456);
  });

  it("reads a process whose name holds spaces and parentheses", () => {
    expect(parseProcStat(read("proc-stat-weird.txt"))).toEqual({
      pid: 4242,
      name: "tmux: server (1)",
      ticks: 200,
      start: 98765,
      rssPages: 2048,
    });
    expect(parseProcStat("garbage")).toBeNull();
  });

  it("finds a version in what a CLI prints", () => {
    expect(versionIn("1.0.113 (Claude Code)")).toBe("1.0.113");
    expect(versionIn("codex-cli 0.41.0")).toBe("0.41.0");
    expect(versionIn("4.103.2 3c2a3d0 with Code 1.103.2")).toBe("4.103.2");
    expect(versionIn("herdr v0.9.1")).toBe("0.9.1");
    expect(versionIn("no version here")).toBeNull();
  });
});

/** A stand-in /proc and cgroup mount the test can change between readings. */
function fakeHost(base: string, cgroupFixture: string) {
  const proc = path.join(base, "proc");
  const cg = path.join(base, "cgroup");
  fs.cpSync(path.join(fixtures, "cgroup", cgroupFixture), cg, { recursive: true });
  const proc_ = (pid: number, name: string, ticks: number, start: number, rss: number, cmd: string) => {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    const fields = Array.from({ length: 50 }, () => "0");
    fields[14 - 3] = String(ticks);
    fields[22 - 3] = String(start);
    fields[24 - 3] = String(rss);
    fs.writeFileSync(path.join(proc, String(pid), "stat"), `${pid} (${name}) ${fields.join(" ")}\n`);
    fs.writeFileSync(path.join(proc, String(pid), "cmdline"), cmd.split(" ").join("\0") + "\0");
  };
  fs.mkdirSync(path.join(proc, "self"), { recursive: true });
  fs.writeFileSync(path.join(proc, "self", "cgroup"), "0::/\n");
  fs.writeFileSync(path.join(proc, "uptime"), "1000.00 500.00\n");
  return {
    proc,
    cg,
    setProc: proc_,
    setCgroupUsage: (usec: number) => fs.writeFileSync(path.join(cg, "cpu.stat"), `usage_usec ${usec}\n`),
  };
}

describe("the system monitor", () => {
  let base: string;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(tmpBase(), "wb-system-"));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("reports limits, usage, the busiest processes and the box's uptime", async () => {
    const host = fakeHost(base, "limited");
    // pid 1 started 100 s after boot (at 100 ticks/s); the host is up 1000 s.
    host.setProc(1, "init", 10, 10_000, 100, "/sbin/init");
    host.setProc(200, "node", 0, 50_000, 10_000, "node server.js --port 3000");
    host.setProc(300, "idle", 0, 60_000, 50, "sleep infinity");
    const monitor = new SystemMonitor({
      cgroupRoot: host.cg,
      procRoot: host.proc,
      disks: [{ label: "workspace", path: base }],
      version: "1.2.3",
      herdrVersion: () => "0.9.1",
      env: { PATH: "" },
    });

    const first = await monitor.info();
    expect(first.container.readable).toBe(true);
    expect(first.container.service).toBe("workbench");
    expect(first.container.cpu.limit).toBe(2);
    expect(first.container.memory).toEqual({ used: 1342177280 - 268435456, limit: 4 * 1024 ** 3 });
    expect(first.container.pids).toEqual({ current: 42, limit: 512 });

    // Some work happens, then the next reading measures it.
    host.setCgroupUsage(5_000_000 + 400_000);
    host.setProc(200, "node", 40, 50_000, 10_000, "node server.js --port 3000");
    await new Promise((r) => setTimeout(r, 200));
    const info: SystemInfo = await monitor.info();
    expect(info.container.cpu.usage).toBeGreaterThan(0);
    // The sandbox as a whole: every process, summed from /proc.
    expect(info.sandbox.cpu).toBeGreaterThan(0);
    expect(info.sandbox.processes).toBe(3);
    expect(info.sandbox.memory).toBe(info.processes.reduce((n, p) => n + p.memory, 0));
    expect(info.processes[0]).toMatchObject({ pid: 200, name: "node", command: "node server.js --port 3000" });
    expect(info.processes[0]!.cpu).toBeGreaterThan(0);
    expect(info.processes.find((p) => p.pid === 300)?.cpu).toBe(0);
    expect(info.processes.find((p) => p.pid === 200)?.memory).toBeGreaterThan(0);
    expect(info.uptime.host).toBe(1000);
    // 1000 s up, pid 1 born at tick 10 000: at the usual 100 ticks/s, 900 s ago.
    expect(info.uptime.box).toBeGreaterThan(0);
    expect(info.uptime.box).toBeLessThanOrEqual(1000);
    expect(info.disks[0]).toMatchObject({ label: "workspace", path: base });
    expect(info.disks[0]!.total).toBeGreaterThan(0);
    expect(info.versions).toMatchObject({ agentbox: "1.2.3", herdr: "0.9.1", codeServer: null, agents: [] });
  });

  it("says when there is no limit", async () => {
    const host = fakeHost(base, "unlimited");
    host.setProc(1, "init", 0, 0, 1, "init");
    const info = await new SystemMonitor({ cgroupRoot: host.cg, procRoot: host.proc, disks: [], version: null, env: { PATH: "" } }).info();
    expect(info.container.cpu.limit).toBeNull();
    expect(info.container.memory.limit).toBeNull();
    expect(info.container.pids).toEqual({ current: 7, limit: null });
  });

  it("keeps only the fifteen busiest processes, and reads only their command lines", async () => {
    const host = fakeHost(base, "limited");
    for (let pid = 1; pid <= 30; pid++) host.setProc(pid, `p${pid}`, 0, 1, pid, `p${pid}`);
    const readFile = vi.spyOn(fsp, "readFile");
    const info = await new SystemMonitor({ cgroupRoot: host.cg, procRoot: host.proc, disks: [], version: null, env: { PATH: "" } }).info();
    const cmdlines = readFile.mock.calls.filter((c) => String(c[0]).endsWith("/cmdline")).length;
    readFile.mockRestore();
    expect(info.processes).toHaveLength(15);
    // All idle, so the largest come first.
    expect(info.processes[0]?.pid).toBe(30);
    expect(info.processes[0]?.command).toBe("p30");
    expect(cmdlines).toBe(15);
    // The whole sandbox is still counted.
    expect(info.sandbox.processes).toBe(30);
  });

  it("reads /proc without holding up the thread", async () => {
    const host = fakeHost(base, "limited");
    for (let pid = 1; pid <= 400; pid++) host.setProc(pid, `p${pid}`, pid, 1, pid, `p${pid}`);
    const readFileSync = vi.spyOn(fs, "readFileSync");
    const readdirSync = vi.spyOn(fs, "readdirSync");
    await new SystemMonitor({ cgroupRoot: host.cg, procRoot: host.proc, disks: [], version: null, env: { PATH: "" } }).info();
    const sync = readFileSync.mock.calls.length + readdirSync.mock.calls.length;
    readFileSync.mockRestore();
    readdirSync.mockRestore();
    expect(sync).toBe(0);
  });

  it("finds the agent CLIs on PATH and asks each for its version", async () => {
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    const script = (name: string, body: string) => {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    script("claude", 'echo "1.0.113 (Claude Code)"');
    script("codex", "exit 1");
    script("code-server", 'echo "4.103.2 3c2a3d0 with Code 1.103.2"');
    script("herdr", 'echo "herdr 0.9.1"');
    const host = fakeHost(base, "unlimited");
    const info = await new SystemMonitor({
      cgroupRoot: host.cg,
      procRoot: host.proc,
      disks: [],
      version: null,
      env: { PATH: bin },
    }).info();
    expect(info.versions).toMatchObject({
      herdr: "0.9.1",
      codeServer: "4.103.2",
      agents: [
        { name: "claude", version: "1.0.113" },
        { name: "codex", version: null },
      ],
    });
  });

  it("reports the version the image was built with", () => {
    // AGENTBOX_VERSION is baked into the image from the checkout's description.
    expect(loadConfig({ AGENTBOX_VERSION: "v1.4.0-3-gabc1234-dirty" }).version).toBe("v1.4.0-3-gabc1234-dirty");
    expect(loadConfig({}).version).toBeNull();
  });

  it("is served at /api/system", async () => {
    const f = await filesFixture();
    try {
      const res = await f.app.inject({ method: "GET", url: "/api/system" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const info = res.json() as SystemInfo;
      expect(info.disks.map((d) => d.label)).toEqual(["workspace", "home"]);
      expect(info.versions.node).toBe(process.versions.node);
      expect(Array.isArray(info.processes)).toBe(true);
    } finally {
      await f.close();
    }
  });
});
