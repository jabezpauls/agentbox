import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SystemDisk, SystemInfo, SystemProcess, SystemVersions } from "@workbench/shared";

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
  cgroupUsec: number | null;
  procs: Map<number, ProcStat>;
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
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

/**
 * What the System surface shows. CPU use is a rate, so it needs two readings:
 * the monitor keeps the last one, and when there is none recent enough it
 * takes a pair a quarter of a second apart.
 */
export class SystemMonitor {
  private last: Sample | null = null;
  private busy: Promise<SystemInfo> | null = null;
  private versions: { at: number; value: Promise<SystemVersions> } | null = null;
  private clkTck: number | null = null;
  private pageSize: number | null = null;
  private readonly proc: string;

  constructor(private readonly opts: SystemOptions) {
    this.proc = opts.procRoot ?? "/proc";
  }

  /** Clock ticks per second, asked of the system on first use. */
  private get clk(): number {
    return (this.clkTck ??= sysconf("CLK_TCK", 100));
  }

  private get page(): number {
    return (this.pageSize ??= sysconf("PAGESIZE", 4096));
  }

  /** The cgroup directory this process is in, or the mount itself. */
  private cgroupDir(): string {
    // Inside a container with its own cgroup namespace the mount *is* our
    // cgroup; with the host's, our path under it is in /proc/self/cgroup.
    const rel = /^0::(\/.*)$/m.exec(read(path.join(this.proc, "self", "cgroup")) ?? "")?.[1];
    if (rel && rel !== "/") {
      const dir = path.join(this.opts.cgroupRoot, rel);
      if (fs.existsSync(path.join(dir, "cgroup.procs")) || fs.existsSync(path.join(dir, "cpu.stat"))) return dir;
    }
    return this.opts.cgroupRoot;
  }

  private sample(cg: string): Sample {
    const cpuStat = read(path.join(cg, "cpu.stat"));
    const procs = new Map<number, ProcStat>();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.proc);
    } catch {
      // no /proc: no process table
    }
    for (const n of names) {
      if (!/^\d+$/.test(n)) continue;
      const st = parseProcStat(read(path.join(this.proc, n, "stat")) ?? "");
      if (st) procs.set(st.pid, st);
    }
    return { at: Date.now(), cgroupUsec: cpuStat ? (parseKeyed(cpuStat).get("usage_usec") ?? null) : null, procs };
  }

  info(): Promise<SystemInfo> {
    // Concurrent callers share one collection rather than each sleeping.
    this.busy ??= this.collect().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async collect(): Promise<SystemInfo> {
    const cg = this.cgroupDir();
    let prev = this.last;
    if (!prev || Date.now() - prev.at > 10_000) {
      prev = this.sample(cg);
      await new Promise((r) => setTimeout(r, 250));
    }
    const now = this.sample(cg);
    this.last = now;
    const secs = Math.max(0.001, (now.at - prev.at) / 1000);

    const cpuMax = read(path.join(cg, "cpu.max"));
    const memCurrent = read(path.join(cg, "memory.current"));
    const memMax = read(path.join(cg, "memory.max"));
    const memStat = parseKeyed(read(path.join(cg, "memory.stat")) ?? "");
    const pidsCurrent = read(path.join(cg, "pids.current"));
    const pidsMax = read(path.join(cg, "pids.max"));
    const cgroup = now.cgroupUsec !== null || memCurrent !== null;

    // Page cache the kernel can drop is not memory anyone is using.
    const memUsed =
      memCurrent !== null
        ? Math.max(0, Number(memCurrent.trim()) - (memStat.get("inactive_file") ?? 0))
        : os.totalmem() - os.freemem();
    const usage =
      now.cgroupUsec !== null && prev.cgroupUsec !== null
        ? (now.cgroupUsec - prev.cgroupUsec) / 1e6 / secs
        : null;

    const processes: SystemProcess[] = [];
    for (const [pid, st] of now.procs) {
      const before = prev.procs.get(pid);
      const delta = before && before.start === st.start ? st.ticks - before.ticks : 0;
      processes.push({
        pid,
        name: st.name,
        command: this.command(pid) ?? st.name,
        cpu: Math.round((delta / this.clk / secs) * 1000) / 10,
        memory: Math.max(0, st.rssPages) * this.page,
      });
    }
    processes.sort((a, b) => b.cpu - a.cpu || b.memory - a.memory || a.pid - b.pid);

    const hostUp = Number((read(path.join(this.proc, "uptime")) ?? "").split(/\s+/)[0]) || os.uptime();
    const init = now.procs.get(1);
    const boxUp = init && Number.isFinite(init.start) ? Math.max(0, hostUp - init.start / this.clk) : null;

    return {
      at: now.at,
      cgroup,
      cpu: {
        usage: usage === null ? null : Math.round(usage * 1000) / 1000,
        limit: cpuMax === null ? null : parseCpuMax(cpuMax),
        cores: os.cpus().length || 1,
      },
      memory: { used: memUsed, limit: memMax === null ? null : parseLimit(memMax), total: os.totalmem() },
      pids: {
        current: pidsCurrent === null ? null : parseLimit(pidsCurrent),
        limit: pidsMax === null ? null : parseLimit(pidsMax),
      },
      disks: await this.disks(),
      uptime: { box: boxUp === null ? null : Math.round(boxUp), bridge: Math.round(process.uptime()), host: Math.round(hostUp) },
      processes: processes.slice(0, 15),
      versions: await this.versionsCached(),
    };
  }

  private command(pid: number): string | null {
    const raw = read(path.join(this.proc, String(pid), "cmdline"));
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
    const onPath = (name: string): string | null => {
      for (const dir of (env.PATH ?? "").split(path.delimiter)) {
        if (!dir) continue;
        const p = path.join(dir, name);
        try {
          fs.accessSync(p, fs.constants.X_OK);
          return p;
        } catch {
          // keep looking
        }
      }
      return null;
    };
    const probe = async (name: string): Promise<string | null> => {
      const bin = onPath(name);
      if (!bin) return null;
      const out = await run(bin, ["--version"], env);
      return out === null ? null : versionIn(out);
    };
    const agentNames = AGENT_CLIS.filter((n) => onPath(n) !== null);
    const [herdr, codeServer, ...agents] = await Promise.all([
      this.opts.herdrVersion?.() ?? probe("herdr"),
      probe("code-server"),
      ...agentNames.map(probe),
    ]);
    return {
      agentbox: this.opts.version,
      herdr: herdr ?? null,
      codeServer: codeServer ?? null,
      node: process.versions.node,
      agents: agentNames.map((name, i) => ({ name, version: agents[i] ?? null })),
    };
  }
}

/** `getconf <name>` once, falling back to the usual Linux value. */
function sysconf(name: string, fallback: number): number {
  try {
    const out = Number(
      // Synchronous and once per process; tiny.
      execFileSync("getconf", [name], { encoding: "utf8", timeout: 2000 }).trim(),
    );
    return Number.isFinite(out) && out > 0 ? out : fallback;
  } catch {
    return fallback;
  }
}
