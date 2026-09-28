import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DavCredentials } from "./dav.js";

/**
 * Mounting the local WebDAV front with what the operating system already has:
 * `mount_webdav` on macOS, gvfs's `gio mount` on Linux, `net use` (the
 * WebClient service) on Windows. Each is run without a shell.
 *
 * The front's password never goes on a command line, where any user of the
 * machine could read it with `ps`: `mount_webdav` reads it from a file
 * descriptor (`-a`), and `gio mount` from its standard input, as it would
 * from a person typing. Windows' WebClient sends Basic credentials only over
 * https, so there nothing is asked and the random path is the secret.
 */

export interface Step {
  command: string;
  args: string[];
  /** Written to the helper's standard input (then closed). */
  input?: string;
  /** Handed to the helper as file descriptor 3, from a file with no name left on disk. */
  fd3?: Buffer;
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
  /** gvfs's folder of mounts, where this one's folder is looked for once mounted. */
  gvfsRoot: string | null;
  /** A folder to create first (and remove afterwards if it was created). */
  mountpoint: string | null;
  /** A link to create at the requested folder, pointing at `where` (gvfs chooses its own place). */
  link: string | null;
}

/**
 * This mount's folder among gvfs's: `dav:host=127.0.0.1,port=N,prefix=%2F<secret>`,
 * give or take parameters that vary by gvfs release (Debian 12's adds
 * `ssl=false`, and `user=` once credentials were given), so it is looked for
 * rather than built.
 */
export function gvfsMountName(names: string[], port: number, secret: string): string | null {
  return names.find((n) => n.startsWith("dav:") && n.split(",").includes(`port=${port}`) && n.includes(`prefix=%2F${secret}`)) ?? null;
}

/**
 * What `mount_webdav -a <fd>` reads (webdavfs's readCredentialsFromFile):
 * the user name, the password, a proxy user name and password, and a
 * certificate chain, each as a 32-bit big-endian length and its bytes. Only
 * the first two are ours; the rest are empty. It seeks to the start first, so
 * the descriptor must be a file (not a pipe), and it zeroes the file after.
 */
export function mountWebdavCredentials(c: DavCredentials): Buffer {
  const field = (s: string): Buffer => {
    const bytes = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    return Buffer.concat([len, bytes]);
  };
  return Buffer.concat([field(c.user), field(c.password), field(""), field(""), field("")]);
}

export function mountPlan(opts: {
  platform: NodeJS.Platform;
  url: string;
  dir: string | null;
  boxName: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** What the front asks for; `null` when it asks nothing (Windows). */
  credentials: DavCredentials | null;
}): MountPlan {
  const { platform, url, dir, credentials } = opts;
  if (platform === "darwin") {
    const mountpoint = path.resolve(dir ?? path.join(opts.home, "agentbox", opts.boxName));
    return {
      helper: "mount_webdav",
      install: "mount_webdav ships with macOS; is /sbin on your PATH?",
      // -S: no "server disconnected" dialogs; -a 3: the credentials, from
      // file descriptor 3; -v: the volume's name in Finder.
      mount: {
        command: "mount_webdav",
        args: ["-S", ...(credentials ? ["-a", "3"] : []), "-v", opts.boxName, url, mountpoint],
        ...(credentials ? { fd3: mountWebdavCredentials(credentials) } : {}),
      },
      unmount: { command: "umount", args: [mountpoint] },
      where: mountpoint,
      gvfsRoot: null,
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
      gvfsRoot: null,
      mountpoint: null,
      link: null,
    };
  }
  const runtime = opts.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
  const davUrl = url.replace(/^http:/, "dav:");
  return {
    helper: "gio",
    install: "install gvfs with its WebDAV backend (Debian/Ubuntu: `sudo apt install gvfs-backends libglib2.0-bin`; Fedora: `sudo dnf install gvfs`), or use `agentbox mount --no-mount` with any WebDAV client",
    // gio asks for the user name and password on its standard input.
    mount: { command: "gio", args: ["mount", davUrl], ...(credentials ? { input: `${credentials.user}\n${credentials.password}\n` } : {}) },
    unmount: { command: "gio", args: ["mount", "-u", davUrl] },
    where: null,
    gvfsRoot: path.join(runtime, "gvfs"),
    mountpoint: null,
    link: dir ? path.resolve(dir) : null,
  };
}

/**
 * Why a folder is no place for the Linux convenience link, or `null`. The
 * link's target names the mount's secret path, and anyone who can list the
 * folder can read a link's target: so the folder must be the user's own and
 * closed to everyone else.
 */
export function linkFolderProblem(folder: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(folder);
  } catch {
    return `${folder}: no such folder`;
  }
  if (!st.isDirectory()) return `${folder} is not a folder`;
  const uid = process.getuid?.();
  if ((st.mode & 0o077) !== 0 || (uid !== undefined && st.uid !== uid)) {
    return `${folder} can be opened by other users, and the link would show them the mount's secret address; make it in a folder only you can open (chmod 700), or leave [dir] out`;
  }
  return null;
}

/** The full path of `command` on PATH, or `null`. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  // macOS keeps mount_webdav in /sbin, which a user's PATH may leave out.
  if (platform === "darwin") dirs.push("/sbin", "/usr/sbin");
  // A name that already has an extension ("notepad.exe") is tried as it is first.
  // (Both cases of each extension: only the tests look on a case-sensitive disk.)
  const exts =
    platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean).flatMap((e) => [e, e.toLowerCase()])] : [""];
  for (const d of dirs) {
    for (const ext of exts) {
      if (platform === "win32" && ext === "" && !/\.[A-Za-z0-9]+$/.test(command)) continue;
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

/**
 * Put `data` in a file that has no name left on disk, and return its
 * descriptor: made private in a private folder, then unlinked at once, so it
 * lives only as long as the descriptor and no one can open it by name.
 */
function anonymousFile(data: Buffer): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-mount-"));
  const file = path.join(dir, "credentials");
  const fd = fs.openSync(file, "wx+", 0o600);
  try {
    fs.writeSync(fd, data, 0, data.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return fd;
}

/** Run a step, collecting its output; resolves with the exit code and what it printed. */
export function runStep(step: Step, helperPath?: string, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let fd: number | null = null;
    const release = (): void => {
      if (fd !== null) fs.closeSync(fd);
      fd = null;
    };
    let child;
    try {
      if (step.fd3) fd = anonymousFile(step.fd3);
      child = spawn(helperPath ?? step.command, step.args, {
        env,
        stdio: [step.input === undefined ? "ignore" : "pipe", "pipe", "pipe", ...(fd !== null ? [fd] : [])],
      });
    } catch (err) {
      release();
      resolve({ code: 127, output: (err as Error).message });
      return;
    }
    if (step.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(step.input);
    }
    child.stdout?.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (output += c.toString()));
    child.once("error", (err) => {
      release();
      resolve({ code: 127, output: err.message });
    });
    child.once("close", (code) => {
      release();
      resolve({ code: code ?? 1, output: output.trim() });
    });
  });
}

/** The drive `net use *` picked, from what it printed ("Drive Z: is now connected…"). */
export function driveFromNetUse(output: string): string | null {
  return /\b([A-Z]:)/.exec(output)?.[1] ?? null;
}
