import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { NodePaths } from "./paths.js";
import { ensurePrivateDir, writePrivate } from "./paths.js";
import { runCommand, type Runner } from "./service-linux.js";

/**
 * The node on Windows, with no admin (the design, "Running as a service"):
 *
 * - a per-user **Run entry** (`HKCU\…\CurrentVersion\Run`, value
 *   `agentbox-node`) starts `agentbox-node.exe node supervise` at sign-in.
 *   `agentbox-node.exe` is the standalone `agentbox.exe` with its PE
 *   subsystem set to GUI, so it has no console and shows no window;
 * - `node supervise` starts the console `agentbox.exe node run` with no
 *   window, writes its output to `state\node.log` (rotated at 10 MB, three
 *   files kept), and restarts it with backoff when it fails. A node that
 *   exits 0 (it left, or was revoked) is not restarted; one that replaced
 *   itself (RESTART_EXIT) is, at once;
 * - it runs while the owner is signed in.
 *
 * Only the standalone executables can be registered: `agentbox.mjs` under
 * `node.exe` would open a console window at every sign-in.
 */

export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const RUN_VALUE = "agentbox-node";
export const GUI_EXE = "agentbox-node.exe";
export const CONSOLE_EXE = "agentbox.exe";
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
/** node.log and two older ones. */
export const LOG_FILES = 3;
/** The exit code of a node that replaced itself (run.ts). */
const RESTART_EXIT = 75;

/** Whether this is the standalone executable (a SEA): its script is itself. */
function standalone(execPath: string, script: string | undefined): boolean {
  return script === undefined || path.resolve(script) === path.resolve(execPath);
}

/** The windowless `agentbox-node.exe` beside this standalone executable, or why there is none. */
export function guiExecutable(execPath: string = process.execPath, script: string | undefined = process.argv[1]): { gui: string } | { problem: string } {
  if (!standalone(execPath, script)) {
    return {
      problem:
        "the Windows sign-in entry needs the standalone agentbox.exe and agentbox-node.exe (this is agentbox.mjs under Node, " +
        "which would open a console window at every sign-in); run `agentbox node run` yourself, or install the standalone executables",
    };
  }
  const gui = path.join(path.dirname(execPath), GUI_EXE);
  if (!fs.existsSync(gui)) return { problem: `${GUI_EXE} is not beside ${execPath}; install it from the same release` };
  return { gui };
}

/** What the Run entry says: the windowless executable, quoted, and `node supervise`. */
export function runEntry(gui: string): string {
  return `"${gui}" node supervise`;
}

/** The console `agentbox.exe node run` a supervisor starts (or, under Node, this script's `node run`). */
export function runCommandLine(execPath: string = process.execPath, script: string | undefined = process.argv[1]): string[] {
  if (!standalone(execPath, script)) return [execPath, path.resolve(script as string), "node", "run"];
  const dir = path.dirname(execPath);
  const exe = path.basename(execPath).toLowerCase() === GUI_EXE ? path.join(dir, CONSOLE_EXE) : execPath;
  return [exe, "node", "run"];
}

export interface WindowsServiceResult {
  entry: string;
}

/** Add the Run entry, and start the supervisor now (hidden, detached), as sign-in would. */
export async function installService(opts: { gui: string; run?: Runner; start?: boolean }): Promise<WindowsServiceResult> {
  const run = opts.run ?? runCommand;
  const entry = runEntry(opts.gui);
  const r = await run("reg.exe", ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", entry, "/f"]);
  if (r.code !== 0) throw new Error(`reg add ${RUN_KEY} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  if (opts.start !== false) {
    const child = spawn(opts.gui, ["node", "supervise"], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  }
  return { entry };
}

/** The Run entry's value, or `null` when there is none. */
export async function readRunEntry(run: Runner = runCommand): Promise<string | null> {
  const r = await run("reg.exe", ["query", RUN_KEY, "/v", RUN_VALUE]);
  if (r.code !== 0) return null;
  return new RegExp(`${RUN_VALUE}\\s+REG_SZ\\s+(.*)`).exec(r.stdout)?.[1]?.trim() ?? null;
}

/** Remove the Run entry and stop a supervisor still running. Resolves whether there was an entry. */
export async function removeService(opts: { paths: NodePaths; run?: Runner }): Promise<boolean> {
  const run = opts.run ?? runCommand;
  const had = (await readRunEntry(run)) !== null;
  if (had) await run("reg.exe", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
  const pid = supervisorPid(opts.paths);
  if (pid !== null && pid !== process.pid) {
    try {
      process.kill(pid);
    } catch {
      // Gone already.
    }
  }
  fs.rmSync(lockFile(opts.paths), { force: true });
  return had;
}

function lockFile(p: NodePaths): string {
  return path.join(p.state, "supervise.json");
}

export function logFile(p: NodePaths): string {
  return path.join(p.state, "node.log");
}

/** A running supervisor's pid, from its lock file; `null` when none runs. */
export function supervisorPid(p: NodePaths): number | null {
  try {
    const { pid } = JSON.parse(fs.readFileSync(lockFile(p), "utf8")) as { pid?: unknown };
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Appends to `file`, moving it to `file.1` (and `.1` to `.2`) when it reaches `max`. */
export class RotatingLog {
  private size: number;

  constructor(
    private readonly file: string,
    private readonly max = LOG_MAX_BYTES,
    private readonly keep = LOG_FILES,
  ) {
    ensurePrivateDir(path.dirname(file));
    try {
      this.size = fs.statSync(file).size;
    } catch {
      this.size = 0;
    }
  }

  write(text: string | Buffer): void {
    const bytes = typeof text === "string" ? Buffer.from(text) : text;
    if (this.size > 0 && this.size + bytes.length > this.max) this.rotate();
    try {
      fs.appendFileSync(this.file, bytes, { mode: 0o600 });
      this.size += bytes.length;
    } catch {
      // A full disk loses log lines, never the node.
    }
  }

  private rotate(): void {
    try {
      fs.rmSync(`${this.file}.${this.keep - 1}`, { force: true });
      for (let i = this.keep - 2; i >= 1; i--) if (fs.existsSync(`${this.file}.${i}`)) fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      // Held open elsewhere: keep appending.
    }
    this.size = 0;
  }
}

export interface SuperviseOptions {
  paths: NodePaths;
  /** What to run: `agentbox.exe node run`. */
  command: string[];
  signal?: AbortSignal;
  now?: () => number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * `agentbox node supervise`: keep `node run` running. Resolves (0) when it
 * exits 0, when the signal aborts, or when another supervisor is running
 * already.
 */
export async function supervise(o: SuperviseOptions): Promise<number> {
  const now = o.now ?? Date.now;
  const log = new RotatingLog(logFile(o.paths));
  const say = (line: string): void => log.write(`${new Date(now()).toISOString()} supervise: ${line}\n`);
  const other = supervisorPid(o.paths);
  if (other !== null && other !== process.pid) {
    say(`another supervisor is running (pid ${other}); leaving it to it`);
    return 0;
  }
  ensurePrivateDir(o.paths.state);
  writePrivate(lockFile(o.paths), `${JSON.stringify({ pid: process.pid })}\n`);
  const [cmd, ...args] = o.command as [string, ...string[]];
  const min = o.minBackoffMs ?? 1_000;
  const max = o.maxBackoffMs ?? 60_000;
  let backoff = min;
  try {
    for (;;) {
      if (o.signal?.aborted) return 0;
      const started = now();
      say(`starting ${path.basename(cmd)} ${args.join(" ")}`);
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: process.env });
      child.stdout?.on("data", (c: Buffer) => log.write(c));
      child.stderr?.on("data", (c: Buffer) => log.write(c));
      const stop = (): void => {
        child.kill();
      };
      o.signal?.addEventListener("abort", stop, { once: true });
      const code = await new Promise<number>((resolve) => {
        child.once("error", (err) => {
          say(`could not start it: ${err.message}`);
          resolve(-1);
        });
        child.once("exit", (c, sig) => resolve(c ?? (sig ? 128 : -1)));
      });
      o.signal?.removeEventListener("abort", stop);
      if (o.signal?.aborted) return 0;
      if (code === 0) {
        say("the node exited 0 (it left, was revoked, or was stopped); not restarting it");
        return 0;
      }
      if (code === RESTART_EXIT) {
        say("the node replaced itself; starting the new one");
        backoff = min;
        continue;
      }
      // It ran a while: a fresh failure, not a crash loop.
      if (now() - started >= 60_000) backoff = min;
      say(`the node exited (code ${code}); restarting in ${Math.round(backoff / 1000)} s`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, max);
    }
  } finally {
    try {
      const held = JSON.parse(fs.readFileSync(lockFile(o.paths), "utf8")) as { pid?: unknown };
      if (held.pid === process.pid) fs.rmSync(lockFile(o.paths), { force: true });
    } catch {
      // Gone already.
    }
  }
}
