import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request } from "@workbench/hostcore/herdr";
import { HERDR_VERSION } from "./install.js";
import { ensurePrivateDir, writePrivate } from "./paths.js";

/**
 * The node's own herdr: its agents and terminals live here.
 *
 * - **Its own session** (`HERDR_SESSION=agentbox-node`), so it never restores
 *   or shows the owner's own herdr workspaces, and a fresh random control
 *   socket path at each start (a Windows pipe name is global; a stale or
 *   squatted one is never reused). The path is kept in `state/herdr.json`
 *   with the server's pid.
 * - **Outlives the node.** herdr runs detached, so a node restart (an update,
 *   a crash) leaves the agents running; the next node adopts the server it
 *   finds there if it answers `ping` with the pinned version.
 * - **Supervised.** Restarted if it exits; its control socket is checked
 *   every 30 s (a listener can die while the process lives), and after two
 *   failed checks in a row it is restarted.
 *
 * Events: `ready` (its address, `{ restored, envPath }` — restored is true when this start was a
 * fresh server, which restores the saved session; envPath is its HERDR_SOCKET_PATH), `down` (it went away;
 * a restart follows), `log` (a line).
 */

export const HERDR_SESSION = "agentbox-node";
export const CHECK_MS = 30_000;
export const FAILED_CHECKS = 2;
const READY_MS = 15_000;
/** sun_path holds 108 bytes on Linux (104 on macOS); leave room for herdr's own `-client` sibling. */
const MAX_SOCKET_PATH = 96;

/**
 * Where a client reaches herdr whose `HERDR_SOCKET_PATH` is `socket`: the
 * socket itself, or on Windows the named pipe `\\.\pipe\` + that path
 * verbatim (herdr leaves a marker file at the path; connecting to the file
 * fails with ENOTSOCK — machines spike, question 1).
 */
export function herdrAddress(socket: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `\\\\.\\pipe\\${socket}` : socket;
}

export interface HerdrOptions {
  /** The herdr executable (the node's verified `bin/herdr`). */
  bin: string;
  /** The node folder: the socket, and `state/herdr.json`. */
  dir: string;
  /** herdr's environment (and so its panes'): PATH with the node's shims first. */
  env: NodeJS.ProcessEnv;
  checkMs?: number;
  /** Test seam: what `ping` must say. */
  version?: string;
}

interface Saved {
  socket: string;
  pid: number;
}

export class HerdrSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private socket: string | null = null;
  private pid: number | null = null;
  private stopped = false;
  private failures = 0;
  private checker: NodeJS.Timeout | null = null;
  private restarting: Promise<void> | null = null;
  private backoff = 1_000;
  private readonly stateFile: string;

  constructor(private readonly o: HerdrOptions) {
    super();
    this.stateFile = path.join(o.dir, "state", "herdr.json");
  }

  /** Where herdr's control socket is reached now (on Windows, its pipe), or `null` while herdr is starting. */
  get socketPath(): string | null {
    return this.socket === null ? null : herdrAddress(this.socket);
  }

  /** `HERDR_SOCKET_PATH` for herdr's own CLI (`terminal session control`), or `null`. */
  get envPath(): string | null {
    return this.socket;
  }

  private log(line: string): void {
    this.emit("log", line);
  }

  private async answers(socket: string): Promise<boolean> {
    try {
      const pong = await request<{ version?: string }>(herdrAddress(socket), "ping", {}, { timeoutMs: 5_000 });
      return pong.version === (this.o.version ?? HERDR_VERSION);
    } catch {
      return false;
    }
  }

  /** A fresh socket path: in the node folder when it fits, else a private folder of its own. */
  private freshSocket(): string {
    const name = `herdr-${randomBytes(4).toString("hex")}.sock`;
    const inNode = path.join(this.o.dir, name);
    // A pipe's name has no such limit.
    if (process.platform === "win32" || Buffer.byteLength(inNode) <= MAX_SOCKET_PATH) return inNode;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-node-"));
    fs.chmodSync(dir, 0o700);
    return path.join(dir, name);
  }

  async start(): Promise<void> {
    this.stopped = false;
    const saved = this.readSaved();
    if (saved && (await this.answers(saved.socket))) {
      this.socket = saved.socket;
      this.pid = saved.pid;
      this.log(`herdr: kept the running server (pid ${saved.pid})`);
      this.emit("ready", herdrAddress(saved.socket), { restored: false, envPath: saved.socket });
    } else {
      if (saved) this.kill(saved.pid);
      await this.spawnServer();
    }
    this.watch();
  }

  private readSaved(): Saved | null {
    try {
      const v = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as Partial<Saved>;
      return typeof v.socket === "string" && typeof v.pid === "number" ? { socket: v.socket, pid: v.pid } : null;
    } catch {
      return null;
    }
  }

  /** Only a herdr of ours: on Linux its command line says so; elsewhere, the pid we recorded. */
  private kill(pid: number): void {
    try {
      if (process.platform === "linux") {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (!cmd.includes("herdr")) return;
      }
      process.kill(pid, "SIGTERM");
    } catch {
      // Gone already.
    }
  }

  private removeSocket(socket: string | null): void {
    if (!socket) return;
    for (const f of [socket, socket.replace(/\.sock$/, "-client.sock")]) fs.rmSync(f, { force: true });
  }

  private async spawnServer(): Promise<void> {
    const old = this.socket;
    this.socket = null;
    this.removeSocket(old);
    const socket = this.freshSocket();
    ensurePrivateDir(path.dirname(this.stateFile));
    const child = spawn(this.o.bin, ["server"], {
      env: { ...this.o.env, HERDR_SOCKET_PATH: socket, HERDR_SESSION },
      stdio: ["ignore", "ignore", "pipe"],
      // Its own session: herdr counts only such a server as a daemon, and it
      // outlives the node.
      detached: true,
      windowsHide: true,
    });
    this.child = child;
    child.stderr?.on("data", (c: Buffer) => this.log(`herdr: ${c.toString("utf8").trim().slice(0, 500)}`));
    child.once("error", (err) => this.log(`herdr: could not start: ${err.message}`));
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopped || this.socket !== socket) return;
      this.log(`herdr exited (code ${code ?? "none"}, signal ${signal ?? "none"}); restarting`);
      this.socket = null;
      this.emit("down");
      void this.restart("it exited");
    });
    child.unref();
    const end = Date.now() + READY_MS;
    while (!(await this.answers(socket))) {
      if (this.stopped || this.child !== child) return;
      if (Date.now() > end) {
        child.kill("SIGTERM");
        throw new Error(`herdr did not answer on ${socket} within ${READY_MS / 1000} s`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    this.socket = socket;
    this.pid = child.pid ?? null;
    if (this.pid !== null) writePrivate(this.stateFile, `${JSON.stringify({ socket, pid: this.pid })}\n`);
    this.failures = 0;
    this.backoff = 1_000;
    this.log(`herdr ${this.o.version ?? HERDR_VERSION} started (pid ${this.pid ?? "?"})`);
    this.emit("ready", herdrAddress(socket), { restored: true, envPath: socket });
  }

  private watch(): void {
    if (this.checker) clearInterval(this.checker);
    this.checker = setInterval(() => void this.check(), this.o.checkMs ?? CHECK_MS);
    this.checker.unref();
  }

  /** One health check: two failures in a row and herdr is restarted. */
  async check(): Promise<void> {
    if (this.stopped || this.restarting || !this.socket) return;
    if (await this.answers(this.socket)) {
      this.failures = 0;
      return;
    }
    this.failures += 1;
    this.log(`herdr: its control socket did not answer (${this.failures} of ${FAILED_CHECKS})`);
    if (this.failures >= FAILED_CHECKS) await this.restart("its control socket stopped answering");
  }

  /** Stop the server and start a fresh one (a hang, an exit, an update while idle). */
  restart(reason: string): Promise<void> {
    if (this.restarting) return this.restarting;
    this.restarting = (async () => {
      this.log(`herdr: restarting (${reason})`);
      this.failures = 0;
      const child = this.child;
      this.child = null;
      if (child) child.kill("SIGTERM");
      else if (this.pid !== null) this.kill(this.pid);
      this.socket = null;
      this.emit("down");
      for (;;) {
        if (this.stopped) return;
        try {
          await this.spawnServer();
          return;
        } catch (err) {
          this.log(`herdr: ${(err as Error).message}; trying again in ${this.backoff / 1000} s`);
          await new Promise((r) => setTimeout(r, this.backoff));
          this.backoff = Math.min(this.backoff * 2, 30_000);
        }
      }
    })().finally(() => {
      this.restarting = null;
    });
    return this.restarting;
  }

  /** No agent is running (the updater replaces herdr and Claude Code only then). */
  async idle(): Promise<boolean> {
    if (!this.socket) return true;
    try {
      const r = await request<{ snapshot: { agents?: unknown[] } }>(herdrAddress(this.socket), "session.snapshot", {}, { timeoutMs: 5_000 });
      return (r.snapshot.agents ?? []).length === 0;
    } catch {
      return false;
    }
  }

  /** Stop supervising. herdr keeps running (its agents with it) unless `kill`. */
  stop(kill = false): void {
    this.stopped = true;
    if (this.checker) clearInterval(this.checker);
    this.checker = null;
    if (kill) {
      if (this.child) this.child.kill("SIGTERM");
      else if (this.pid !== null) this.kill(this.pid);
    }
  }
}
