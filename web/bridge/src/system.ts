import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SystemDisk, SystemInfo, SystemProcess, SystemVersions } from "@workbench/shared";
import { mapLimit } from "./files/entries.js";

// --- parsing (pure, tested against fixtures) --------------------------------

/** `cpu.max`: "<quota> <period>" or "max <period>" → CPUs, or null for no limit. */
export function parseCpuMax(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/);
  if (!quota || quota === "max") return null;
  const q = Number(quota);
  const p = Number(period ?? 100_000);
  return q > 0 && p > 0 ? q / p : null;
}

/** A flat `key value` file such as `cpu.stat` or `memory.stat`. */
export function parseKeyed(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v !== undefined && /^\d+$/.test(v)) out.set(k, Number(v));
  }
  return out;
}

/** A single-value limit file (`memory.max`, `pids.max`): a number, or null for "max". */
export function parseLimit(text: string): number | null {
  const t = text.trim();
  return t === "" || t === "max" ? null : Number.isFinite(Number(t)) ? Number(t) : null;
}

/** The fields of `/proc/<pid>/stat` the process table needs. */
export interface ProcStat {
  pid: number;
  name: string;
  /** utime + stime, in clock ticks. */
  ticks: number;
  /** Clock ticks after boot at which the process started. */
  start: number;
  /** Resident set, in pages. */
  rssPages: number;
}

/**
 * Parse a `/proc/<pid>/stat` line. The command name sits in parentheses and
 * may itself hold spaces and parentheses, so the fields are counted from the
 * last `)`.
 */
export function parseProcStat(text: string): ProcStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open === -1 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const name = text.slice(open + 1, close);
  // Field 3 (state) is the first after the name; utime is field 14.
  const f = text.slice(close + 2).trim().split(/\s+/);
  const at = (field: number): number => Number(f[field - 3] ?? NaN);
  const ticks = at(14) + at(15);
  if (!Number.isFinite(pid) || !Number.isFinite(ticks)) return null;
  return { pid, name, ticks, start: at(22), rssPages: at(24) };
}

/** The first version-looking token in a `--version` answer. */
export function versionIn(text: string): string | null {
  const m = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/.exec(text);
  return m ? m[1]! : null;
}

// --- collection --------------------------------------------------------------

/** Coding-agent CLIs worth reporting when they are on PATH. */
export const AGENT_CLIS = ["claude", "codex", "gemini", "opencode", "aider", "amp", "cursor-agent", "qwen", "goose", "crush"];

export interface SystemOptions {
  /** The cgroup v2 mount, `/sys/fs/cgroup` in production. */
  cgroupRoot: string;
  /** `/proc`, or a stand-in. */
  procRoot?: string;
  disks: { label: SystemDisk["label"]; path: string }[];
  version: string | null;
  /** herdr's version as the session hub last saw it, when connected. */
  herdrVersion?: () => string | null;
  env?: NodeJS.ProcessEnv;
  /** How long version probes are trusted; they change only on an update. */
  versionsTtlMs?: number;
}

interface Sample {
  at: number;
  /** Host uptime in seconds when the sample was taken. */
  uptime: number;
  cgroupUsec: number | null;
  procs: Map<number, ProcStat>;
}

async function read(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      resolve(err ? null : `${stdout}\n${stderr}`);
    });
  });
}

/** `getconf <name>`, or the usual Linux value. */
async function sysconf(name: string, fallback: number): Promise<number> {
  const out = Number((await run("getconf", [name], process.env, 2000))?.trim());
  return Number.isFinite(out) && out > 0 ? out : fallback;
}

/**
 * What the System surface shows. CPU use is a rate, so it needs two readings:
 * the monitor keeps the last one, and when there is none recent enough it
 * takes a pair a quarter of a second apart. Everything is read without
 * blocking: the bridge serves terminals on the same thread, and a process
 * table is hundreds of small files.
 */
export class SystemMonitor {
  private last: Sample | null = null;
  private busy: Promise<SystemInfo> | null = null;
  private versions: { at: number; value: Promise<SystemVersions> } | null = null;
  private consts: Promise<{ clk: number; page: number }> | null = null;
  private readonly proc: string;

  constructor(private readonly opts: SystemOptions) {
    this.proc = opts.procRoot ?? "/proc";
  }

  /** Clock ticks per second and the page size, asked of the system once. */
  private constants(): Promise<{ clk: number; page: number }> {
    this.consts ??= Promise.all([sysconf("CLK_TCK", 100), sysconf("PAGESIZE", 4096)]).then(([clk, page]) => ({ clk, page }));
    return this.consts;
  }

  /** The cgroup directory this process is in, or the mount itself. */
  private async cgroupDir(): Promise<string> {
    // Inside a container with its own cgroup namespace the mount *is* our
    // cgroup; with the host's, our path under it is in /proc/self/cgroup.
    const rel = /^0::(\/.*)$/m.exec((await read(path.join(this.proc, "self", "cgroup"))) ?? "")?.[1];
    if (rel && rel !== "/") {
      const dir = path.join(this.opts.cgroupRoot, rel);
      const known = await fsp.access(path.join(dir, "cpu.stat")).then(
        () => true,
        () => false,
      );
      if (known) return dir;
    }
    return this.opts.cgroupRoot;
  }

  private async sample(cg: string): Promise<Sample> {
    const [cpuStat, uptime, names] = await Promise.all([
      read(path.join(cg, "cpu.stat")),
      read(path.join(this.proc, "uptime")),
      fsp.readdir(this.proc).catch(() => [] as string[]),
    ]);
    const procs = new Map<number, ProcStat>();
    await mapLimit(
      names.filter((n) => /^\d+$/.test(n)),
      32,
      async (n) => {
        const st = parseProcStat((await read(path.join(this.proc, n, "stat"))) ?? "");
        if (st) procs.set(st.pid, st);
      },
    );
    return {
      at: Date.now(),
      uptime: Number((uptime ?? "").split(/\s+/)[0]) || os.uptime(),
      cgroupUsec: cpuStat ? (parseKeyed(cpuStat).get("usage_usec") ?? null) : null,
      procs,
    };
  }

  info(): Promise<SystemInfo> {
    // Concurrent callers share one collection rather than each sleeping.
    this.busy ??= this.collect().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async collect(): Promise<SystemInfo> {
    const { clk, page } = await this.constants();
    const cg = await this.cgroupDir();
    let prev = this.last;
    if (!prev || Date.now() - prev.at > 10_000) {
      prev = await this.sample(cg);
      await new Promise((r) => setTimeout(r, 250));
    }
    const now = await this.sample(cg);
    this.last = now;
    const secs = Math.max(0.001, (now.at - prev.at) / 1000);

    const cgFile = (f: string) => read(path.join(cg, f));
    const [cpuMax, memCurrent, memMax, memStatText, pidsCurrent, pidsMax] = await Promise.all([
      cgFile("cpu.max"),
      cgFile("memory.current"),
      cgFile("memory.max"),
      cgFile("memory.stat"),
      cgFile("pids.current"),
      cgFile("pids.max"),
    ]);
    const memStat = parseKeyed(memStatText ?? "");

    // Every process, and what each did since the last reading. One that
    // started since then did all of its work in the window.
    let busyTicks = 0;
    let rss = 0;
    const rows: SystemProcess[] = [];
    for (const [pid, st] of now.procs) {
      const before = prev.procs.get(pid);
      const bornAfter = now.uptime - st.start / clk < secs;
      const delta = Math.max(0, before && before.start === st.start ? st.ticks - before.ticks : bornAfter ? st.ticks : 0);
      busyTicks += delta;
      const memory = Math.max(0, st.rssPages) * page;
      rss += memory;
      rows.push({ pid, name: st.name, command: st.name, cpu: Math.round((delta / clk / secs) * 1000) / 10, memory });
    }
    rows.sort((a, b) => b.cpu - a.cpu || b.memory - a.memory || a.pid - b.pid);
    // Only the rows shown are worth a command line each.
    const processes = await Promise.all(
      rows.slice(0, 15).map(async (p) => ({ ...p, command: (await this.command(p.pid)) ?? p.name })),
    );

    const init = now.procs.get(1);
    const boxUp = init && Number.isFinite(init.start) ? Math.max(0, now.uptime - init.start / clk) : null;
    const containerCpu =
      now.cgroupUsec !== null && prev.cgroupUsec !== null ? (now.cgroupUsec - prev.cgroupUsec) / 1e6 / secs : null;

    return {
      at: now.at,
      sandbox: {
        cpu: Math.round((busyTicks / clk / secs) * 1000) / 1000,
        memory: rss,
        processes: now.procs.size,
      },
      host: { cores: os.cpus().length || 1, memory: os.totalmem() },
      container: {
        service: "workbench",
        readable: now.cgroupUsec !== null || memCurrent !== null,
        cpu: {
          usage: containerCpu === null ? null : Math.round(containerCpu * 1000) / 1000,
          limit: cpuMax === null ? null : parseCpuMax(cpuMax),
        },
        memory: {
          // Page cache the kernel can drop is not memory anyone is using.
          used: memCurrent === null ? null : Math.max(0, Number(memCurrent.trim()) - (memStat.get("inactive_file") ?? 0)),
          limit: memMax === null ? null : parseLimit(memMax),
        },
        pids: {
          current: pidsCurrent === null ? null : parseLimit(pidsCurrent),
          limit: pidsMax === null ? null : parseLimit(pidsMax),
        },
      },
      disks: await this.disks(),
      uptime: { box: boxUp === null ? null : Math.round(boxUp), bridge: Math.round(process.uptime()), host: Math.round(now.uptime) },
      processes,
      versions: await this.versionsCached(),
    };
  }

  private async command(pid: number): Promise<string | null> {
    const raw = await read(path.join(this.proc, String(pid), "cmdline"));
    if (!raw) return null;
    const cmd = raw.replace(/\0+$/, "").split("\0").join(" ");
    return cmd.length > 200 ? `${cmd.slice(0, 199)}…` : cmd;
  }

  private async disks(): Promise<SystemDisk[]> {
    const out: SystemDisk[] = [];
    for (const d of this.opts.disks) {
      try {
        const s = await fsp.statfs(d.path);
        const total = s.blocks * s.bsize;
        out.push({ label: d.label, path: d.path, total, used: (s.blocks - s.bfree) * s.bsize, available: s.bavail * s.bsize });
      } catch {
        // a root that is not mounted in this environment
      }
    }
    return out;
  }

  private versionsCached(): Promise<SystemVersions> {
    const ttl = this.opts.versionsTtlMs ?? 10 * 60 * 1000;
    if (!this.versions || Date.now() - this.versions.at > ttl) {
      this.versions = { at: Date.now(), value: this.probeVersions() };
    }
    return this.versions.value;
  }

  private async probeVersions(): Promise<SystemVersions> {
    const env = this.opts.env ?? process.env;
    const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
    const onPath = async (name: string): Promise<string | null> => {
      for (const dir of dirs) {
        const p = path.join(dir, name);
        const ok = await fsp.access(p, fsp.constants.X_OK).then(
          () => true,
          () => false,
        );
        if (ok) return p;
      }
      return null;
    };
    const probe = async (bin: string | null): Promise<string | null> => {
      if (!bin) return null;
      const out = await run(bin, ["--version"], env);
      return out === null ? null : versionIn(out);
    };
    const found = await Promise.all(AGENT_CLIS.map(async (n) => [n, await onPath(n)] as const));
    const agents = found.filter(([, bin]) => bin !== null);
    const [herdr, codeServer, ...agentVersions] = await Promise.all([
      this.opts.herdrVersion?.() ?? onPath("herdr").then(probe),
      onPath("code-server").then(probe),
      ...agents.map(([, bin]) => probe(bin)),
    ]);
    return {
      agentbox: this.opts.version,
      herdr: herdr ?? null,
      codeServer: codeServer ?? null,
      node: process.versions.node,
      agents: agents.map(([name], i) => ({ name, version: agentVersions[i] ?? null })),
    };
  }
}
