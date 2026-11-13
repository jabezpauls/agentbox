import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The node's folder and what is in it. Everything the node keeps is here,
 * owner-only: the folder `0700`, every file `0600`.
 *
 *   policy.json        what the box may do here (the owner's; `join` writes it once)
 *   credentials.json   node token, machine id, box URL, presence verifier
 *   secrets/           the shared Claude token, when opted in
 *   claude/, shims/    Claude Code's config folder and its shim (claude.ts)
 *   agents.md          agentbox's instructions for agents here
 *   bin/               herdr, Claude Code (verified)
 *   state/             trash, upload state, the local log
 *   control.sock       the local control socket (control.ts)
 *   control.secret     what each control request carries
 */

export interface NodePaths {
  dir: string;
  policy: string;
  credentials: string;
  secrets: string;
  bin: string;
  state: string;
  control: string;
  controlSecret: string;
}

/** `~/.local/share/agentbox/node` (or under `$XDG_DATA_HOME`); `%LOCALAPPDATA%\agentbox\node` on Windows. */
export function nodeDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : path.win32.join(home, "AppData", "Local");
    return path.win32.join(local, "agentbox", "node");
  }
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "share");
  return path.join(base, "agentbox", "node");
}

export function nodePaths(dir: string): NodePaths {
  return {
    dir,
    policy: path.join(dir, "policy.json"),
    credentials: path.join(dir, "credentials.json"),
    secrets: path.join(dir, "secrets"),
    bin: path.join(dir, "bin"),
    state: path.join(dir, "state"),
    control: path.join(dir, "control.sock"),
    controlSecret: path.join(dir, "control.secret"),
  };
}

/** The folder, there and private. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

/** Replace `file` atomically with `contents`, private from the first byte. */
export function writePrivate(file: string, contents: string | Uint8Array, mode = 0o600): void {
  ensurePrivateDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeFileSync(fd, contents);
    if (process.platform !== "win32") fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
