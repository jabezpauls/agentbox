import type { Globals } from "./args.js";
import { ConfigStore, type BoxEntry } from "./config.js";
import { BoxClient } from "./http.js";
import { VERSION } from "./version.js";

/**
 * What every command runs with: where to write, the configuration, the global
 * options, and the box it is talking to. Tests build one with their own
 * streams and a configuration directory of their own.
 */

export interface OutStream {
  write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  once?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface InStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  isRaw?: boolean;
}

export interface Io {
  stdout: OutStream;
  stderr: OutStream;
  stdin: InStream;
}

export interface Connected {
  name: string;
  box: BoxEntry;
  client: BoxClient;
}

/** The box's version is compared with the CLI's at most this often. */
export const VERSION_CHECK_MS = 24 * 60 * 60_000;

export class Context {
  private readonly clients: BoxClient[] = [];
  /** Aborted on Ctrl-C, so a transfer in flight stops cleanly. */
  readonly abort = new AbortController();

  constructor(
    readonly io: Io,
    readonly env: NodeJS.ProcessEnv,
    readonly config: ConfigStore,
    readonly globals: Globals,
    readonly platform: NodeJS.Platform = process.platform,
    readonly now: () => number = Date.now,
  ) {}

  get json(): boolean {
    return this.globals.json;
  }

  out(text: string): void {
    this.io.stdout.write(text);
  }

  /** Human-facing messages go to stderr, so stdout stays clean for data and JSON. */
  err(text: string): void {
    this.io.stderr.write(text);
  }

  warn(message: string): void {
    this.err(`warning: ${message}\n`);
  }

  printJson(value: unknown): void {
    this.out(`${JSON.stringify(value, null, 2)}\n`);
  }

  /** The box `--box` (or `$AGENTBOX_BOX`) names, or the current one. */
  selected(): { name: string; box: BoxEntry } {
    return this.config.resolve(this.globals.box ?? (this.env.AGENTBOX_BOX || null));
  }

  /** A client for a box, closed when the command ends. */
  client(origin: string, token: string | null): BoxClient {
    const c = new BoxClient(origin, token);
    this.clients.push(c);
    return c;
  }

  /**
   * The selected box and a signed-in client for it. Once a day it also asks
   * the box which version it runs, and warns when this CLI differs.
   */
  async connect(opts: { checkVersion?: boolean } = {}): Promise<Connected> {
    const { name, box } = this.selected();
    const client = this.client(box.url, box.token);
    if (opts.checkVersion !== false && this.now() - (box.versionCheckedAt ?? 0) > VERSION_CHECK_MS) {
      await this.checkVersion(name, client);
    }
    return { name, box, client };
  }

  /** Ask the box its version, remember the answer, and warn on a difference. Never fails the command. */
  async checkVersion(name: string, client: BoxClient): Promise<string | null> {
    let version: string | null = null;
    try {
      const res = await client.json<{ version?: unknown }>("GET", "/_gate/version", { idleMs: 10_000 });
      version = typeof res?.version === "string" ? res.version : null;
    } catch {
      return null;
    }
    try {
      this.config.update((data) => {
        const entry = data.boxes[name];
        if (entry) {
          entry.versionCheckedAt = this.now();
          if (version) entry.boxVersion = version;
        }
      });
    } catch {
      // A read-only configuration costs only the reminder's schedule.
    }
    if (version && version !== VERSION) {
      this.warn(`this CLI is agentbox ${VERSION}, but ${name} (${client.origin}) runs ${version}; run \`agentbox update\``);
    }
    return version;
  }

  close(): void {
    for (const c of this.clients) c.close();
  }
}

export function defaultIo(): Io {
  return { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
}

export function makeConfig(env: NodeJS.ProcessEnv, dir: string, io: Io): ConfigStore {
  return new ConfigStore(dir, { warn: (m) => io.stderr.write(`warning: ${m}\n`) });
}
