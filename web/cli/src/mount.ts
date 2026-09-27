import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Mounting the local WebDAV front with what the operating system already has:
 * `mount_webdav` on macOS, gvfs's `gio mount` on Linux, `net use` (the
 * WebClient service) on Windows. Each is run without a shell.
 */

export interface Step {
  command: string;
  args: string[];
}

export interface MountPlan {
  /** The helper that must be on PATH. */
  helper: string;
  /** What to install when it is not. */
  install: string;
  mount: Step;
  unmount: Step | null;
  /** Where the files appear, when that is known before mounting. */
  where: string | null;
  /** A folder to create first (and remove afterwards if it was created). */
  mountpoint: string | null;
  /** A link to create at the requested folder, pointing at `where` (gvfs chooses its own place). */
  link: string | null;
}

/** gvfs's own folder for a dav mount: `…/gvfs/dav:host=127.0.0.1,port=N,prefix=%2F<secret>`. */
export function gvfsPath(runtimeDir: string, port: number, secret: string): string {
  return path.join(runtimeDir, "gvfs", `dav:host=127.0.0.1,port=${port},prefix=%2F${secret}`);
}

export function mountPlan(opts: {
  platform: NodeJS.Platform;
  url: string;
  port: number;
  secret: string;
  dir: string | null;
  boxName: string;
  home: string;
  env: NodeJS.ProcessEnv;
}): MountPlan {
  const { platform, url, port, secret, dir } = opts;
  if (platform === "darwin") {
    const mountpoint = path.resolve(dir ?? path.join(opts.home, "agentbox", opts.boxName));
    return {
      helper: "mount_webdav",
      install: "mount_webdav ships with macOS; is /sbin on your PATH?",
      // -S: no "server disconnected" dialogs; -v: the volume's name in Finder.
      mount: { command: "mount_webdav", args: ["-S", "-v", opts.boxName, url, mountpoint] },
      unmount: { command: "umount", args: [mountpoint] },
      where: mountpoint,
      mountpoint,
      link: null,
    };
  }
  if (platform === "win32") {
    const drive = dir ? dir.replace(/[\\/]+$/, "") : "*";
    if (drive !== "*" && !/^[A-Za-z]:$/.test(drive)) throw new Error("on Windows, mount to a drive letter, e.g. `agentbox mount Z:`");
    return {
      helper: "net",
      install: "`net use` needs the WebClient service: start it with `sc start WebClient` (or enable \"WebDAV Redirector\")",
      mount: { command: "net", args: ["use", drive, url, "/persistent:no"] },
      // The drive letter is only known once `net use` says it.
      unmount: drive === "*" ? null : { command: "net", args: ["use", drive, "/delete", "/y"] },
      where: drive === "*" ? null : drive.toUpperCase(),
      mountpoint: null,
      link: null,
    };
  }
  const runtime = opts.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
  const davUrl = url.replace(/^http:/, "dav:");
  const where = gvfsPath(runtime, port, secret);
  return {
    helper: "gio",
    install: "install gvfs with its WebDAV backend (Debian/Ubuntu: `sudo apt install gvfs-backends libglib2.0-bin`; Fedora: `sudo dnf install gvfs`), or use `agentbox mount --no-mount` with any WebDAV client",
    mount: { command: "gio", args: ["mount", davUrl] },
    unmount: { command: "gio", args: ["mount", "-u", davUrl] },
    where,
    mountpoint: null,
    link: dir ? path.resolve(dir) : null,
  };
}

/** The full path of `command` on PATH, or `null`. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  // macOS keeps mount_webdav in /sbin, which a user's PATH may leave out.
  if (platform === "darwin") dirs.push("/sbin", "/usr/sbin");
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const d of dirs) {
    for (const ext of exts) {
      const full = path.join(d, command + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** Run a step, collecting its output; resolves with the exit code and what it printed. */
export function runStep(step: Step, helperPath?: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn(helperPath ?? step.command, step.args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: 127, output: (err as Error).message });
      return;
    }
    child.stdout.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr.on("data", (c: Buffer) => (output += c.toString()));
    child.once("error", (err) => resolve({ code: 127, output: err.message }));
    child.once("close", (code) => resolve({ code: code ?? 1, output: output.trim() }));
  });
}

/** The drive `net use *` picked, from what it printed ("Drive Z: is now connected…"). */
export function driveFromNetUse(output: string): string | null {
  return /\b([A-Z]:)/.exec(output)?.[1] ?? null;
}
