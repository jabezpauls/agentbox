import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, EXIT, UsageError } from "./errors.js";
import { withFileLock } from "./lock.js";

/**
 * The CLI's configuration: the boxes it is signed in to, and which one is
 * current. One JSON file, `~/.config/agentbox/config.json` (or under
 * `$XDG_CONFIG_HOME`), readable by its owner alone, because it holds each
 * box's device token — the only place the token is ever written.
 *
 * Every change is a read-modify-write of the file as it is now, never of a
 * copy loaded at start-up: a `mount` left running for an hour must not undo a
 * `login` made in another terminal meanwhile. The write is atomic (a private
 * temporary file renamed over the old one), so a crash leaves the old file or
 * the new one, never half of either.
 */

export interface BoxEntry {
  /** The box's origin, e.g. `https://work.example.com`. */
  url: string;
  /** The device token (`abx_…`). Never printed. */
  token: string;
  /** The token's id at the box, as Settings → Devices lists it. */
  tokenId?: string;
  /** Who the box says is signed in. */
  user?: string;
  /** The name the device was approved under. */
  device?: string;
  addedAt: number;
  /** When the box's version was last compared with the CLI's, and what it said. */
  versionCheckedAt?: number;
  boxVersion?: string;
}

export interface ConfigData {
  version: 1;
  current: string | null;
  boxes: Record<string, BoxEntry>;
}

/**
 * A table of boxes by name. Without a prototype, so a box called
 * `constructor` or `__proto__` is a box like any other and never an
 * inherited property.
 */
export function boxTable(): Record<string, BoxEntry> {
  return Object.create(null) as Record<string, BoxEntry>;
}

export function hasBox(boxes: Record<string, BoxEntry>, name: string): boolean {
  return Object.hasOwn(boxes, name);
}

export function emptyConfig(): ConfigData {
  return { version: 1, current: null, boxes: boxTable() };
}

/**
 * Where the configuration lives: on Windows `%APPDATA%\agentbox`; elsewhere
 * `$XDG_CONFIG_HOME/agentbox`, else `~/.config/agentbox`.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32" && env.APPDATA && path.win32.isAbsolute(env.APPDATA)) return path.win32.join(env.APPDATA, "agentbox");
  const xdg = env.XDG_CONFIG_HOME;
  // The XDG spec: a relative value is invalid and must be ignored.
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config");
  return path.join(base, "agentbox");
}

const BOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function checkBoxName(name: string): string {
  if (!BOX_NAME.test(name)) {
    throw new UsageError(`"${name}" is not a usable box name: letters, digits, '.', '_' and '-', up to 64`);
  }
  return name;
}

/**
 * The origin a box is reached at, from whatever was typed: `work.example.com`
 * means https, a URL pasted from the address bar keeps only its origin.
 */
export function normalizeBoxUrl(raw: string): string {
  let s = raw.trim();
  if (s === "") throw new UsageError("give the box's address, e.g. https://work.example.com");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new UsageError(`"${raw}" is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageError(`a box is reached over https (or http on your own machine), not ${url.protocol}`);
  }
  if (url.username || url.password) throw new UsageError("leave the user name and password out of the URL; the box signs you in in the browser");
  return url.origin;
}

/** True for addresses on this machine, where plain http carries the token no further than loopback. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * A short name for a box, from its address: `work.example.com` is "work";
 * an address without a domain (`localhost:7900`, an IP) keeps its port so
 * two local boxes do not collide.
 */
export function defaultBoxName(origin: string): string {
  const url = new URL(origin);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const isIp = /^[\d.]+$/.test(host) || host.includes(":");
  let name = !isIp && host.includes(".") ? (host.split(".")[0] as string) : `${host}${url.port ? `-${url.port}` : ""}`;
  name = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
  return name === "" ? "box" : name;
}

export interface ConfigOptions {
  /** Told when the file had to be tightened. */
  warn?: (message: string) => void;
  /** Only POSIX file modes mean anything; Windows keeps the file in the user's profile. */
  posix?: boolean;
  /** How long a change waits for another process's change to finish. */
  lockTimeoutMs?: number;
}

export class ConfigStore {
  readonly file: string;
  private readonly warn: (message: string) => void;
  private readonly posix: boolean;
  private readonly lockTimeoutMs: number | undefined;

  constructor(
    readonly dir: string,
    opts: ConfigOptions = {},
  ) {
    this.file = path.join(dir, "config.json");
    this.warn = opts.warn ?? (() => {});
    this.posix = opts.posix ?? process.platform !== "win32";
    this.lockTimeoutMs = opts.lockTimeoutMs;
  }

  /** The configuration as it is on disk now; empty when there is none yet. */
  load(): ConfigData {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
      throw new CliError(`cannot read ${this.file}: ${(err as Error).message}`);
    }
    this.tighten();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new CliError(`${this.file} is not valid JSON; fix it or remove it and sign in again`);
    }
    return parseConfig(data, this.file);
  }

  /**
   * Change the configuration: `fn` gets the file's current contents to
   * modify in place, and whatever it returns is returned once the change is
   * safely on disk. The read, the change and the write happen under a lock
   * file, so two processes changing it at once do not lose either change.
   */
  update<T>(fn: (data: ConfigData) => T): T {
    this.ensureDir();
    return withFileLock(
      this.file,
      () => {
        const data = this.load();
        const result = fn(data);
        this.write(data);
        return result;
      },
      this.lockTimeoutMs === undefined ? {} : { timeoutMs: this.lockTimeoutMs },
    );
  }

  /** The box `name`, or the current one; a clear error when there is none. */
  resolve(name?: string | null): { name: string; box: BoxEntry } {
    const data = this.load();
    const chosen = name ?? data.current;
    if (!chosen) {
      throw new CliError(
        Object.keys(data.boxes).length === 0
          ? "not signed in to any box yet: run `agentbox login <url>`"
          : "no box is selected: run `agentbox use <name>` (see `agentbox boxes`)",
        EXIT.AUTH,
      );
    }
    const box = hasBox(data.boxes, chosen) ? data.boxes[chosen] : undefined;
    if (!box) throw new CliError(`no box named "${chosen}" (see \`agentbox boxes\`)`, EXIT.NOT_FOUND);
    return { name: chosen, box };
  }

  /**
   * A file the owner alone may read. An existing one that is open to others
   * (copied with `cp`, restored from a backup) is closed again, and said so.
   */
  private tighten(): void {
    if (!this.posix) return;
    try {
      const st = fs.statSync(this.file);
      if ((st.mode & 0o077) !== 0) {
        fs.chmodSync(this.file, 0o600);
        this.warn(`${this.file} was readable by other users; it holds your device tokens, so it is now private (0600)`);
      }
      const dst = fs.statSync(this.dir);
      if ((dst.mode & 0o077) !== 0) fs.chmodSync(this.dir, 0o700);
    } catch {
      // Gone since it was read, or not ours to change: the read already worked.
    }
  }

  /** The folder, there and private (a strict umask would leave it unwritable). */
  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (this.posix) {
      try {
        fs.chmodSync(this.dir, 0o700);
      } catch {
        // A directory we do not own; the file itself is still private.
      }
    }
  }

  private write(data: ConfigData): void {
    this.ensureDir();
    const tmp = path.join(this.dir, `.config.${randomBytes(6).toString("hex")}.tmp`);
    // Created private (`wx`: never through someone else's file or link), and
    // chmod'ed besides, since a umask can only take permissions away and a
    // strict one would leave the owner unable to write it next time.
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
      if (this.posix) fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } catch (err) {
      fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    fs.closeSync(fd);
    try {
      fs.renameSync(tmp, this.file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw new CliError(`cannot write ${this.file}: ${(err as Error).message}`);
    }
  }
}

function parseConfig(data: unknown, file: string): ConfigData {
  const bad = (): never => {
    throw new CliError(`${file} is not an agentbox configuration; fix it or remove it and sign in again`);
  };
  if (typeof data !== "object" || data === null) return bad();
  const d = data as Record<string, unknown>;
  if (d.version !== 1) return bad();
  const boxes = boxTable();
  if (typeof d.boxes !== "object" || d.boxes === null) return bad();
  for (const [name, value] of Object.entries(d.boxes as Record<string, unknown>)) {
    const b = value as Partial<BoxEntry> | null;
    if (!b || typeof b.url !== "string" || typeof b.token !== "string") return bad();
    boxes[name] = { ...b, url: b.url, token: b.token, addedAt: typeof b.addedAt === "number" ? b.addedAt : 0 };
  }
  const current = typeof d.current === "string" && hasBox(boxes, d.current) ? d.current : null;
  return { version: 1, current, boxes };
}

/** A box as it may be shown: everything but the token. */
export function publicView(name: string, box: BoxEntry, current: boolean): Record<string, unknown> {
  return {
    name,
    url: box.url,
    current,
    user: box.user ?? null,
    device: box.device ?? null,
    tokenId: box.tokenId ?? null,
    addedAt: box.addedAt,
  };
}
