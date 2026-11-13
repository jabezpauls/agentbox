import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hello, PolicySummary } from "@workbench/hostcore/link";

/**
 * What the machine says about itself in its hello: shown in the machines
 * list (and, later, what compute-job placement reads). Every probe is best
 * effort: a missing tool is "not there", never a failure.
 */

export type Specs = Omit<Hello, "type" | "protocol" | "version" | "nonce" | "policy">;

function run(cmd: string, args: string[], timeoutMs = 3_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function onPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, cmd + ext), fs.constants.X_OK);
        return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

async function gpus(env: NodeJS.ProcessEnv): Promise<Specs["gpus"]> {
  if (onPath("nvidia-smi", env)) {
    const out = await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
    if (out) {
      return out
        .split("\n")
        .map((l) => l.split(",").map((s) => s.trim()))
        .filter((p) => p[0])
        .map(([name, mem]) => ({ name: name as string, memoryMiB: Number(mem) || null }));
    }
  }
  if (onPath("rocm-smi", env)) {
    const out = await run("rocm-smi", ["--showproductname", "--csv"]);
    if (out) {
      return out
        .split("\n")
        .slice(1)
        .map((l) => l.split(",")[2]?.trim() ?? "")
        .filter(Boolean)
        .map((name) => ({ name, memoryMiB: null }));
    }
  }
  return [];
}

function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** Claude Code's version: the node's own copy first, then the one on PATH. */
async function claudeVersion(binDir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const own = path.join(binDir, process.platform === "win32" ? "claude.exe" : "claude");
  const cmd = fs.existsSync(own) ? own : onPath("claude", env) ? "claude" : null;
  if (!cmd) return null;
  const out = await run(cmd, ["--version"], 5_000);
  return out ? (/\d+\.\d+\.\d+/.exec(out)?.[0] ?? null) : null;
}

export async function gatherSpecs(opts: { binDir: string; policy: PolicySummary; env?: NodeJS.ProcessEnv }): Promise<Specs> {
  const env = opts.env ?? process.env;
  const cpus = os.cpus();
  const disks: Specs["disks"] = [];
  for (const f of opts.policy.files) {
    const free = freeBytes(f.path);
    if (free !== null) disks.push({ path: f.path, freeBytes: free });
  }
  return {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    cpu: { model: cpus[0]?.model ?? "", cores: cpus.length },
    ramBytes: os.totalmem(),
    disks,
    gpus: await gpus(env),
    docker: onPath("docker", env),
    claude: await claudeVersion(opts.binDir, env),
  };
}

export { freeBytes };
