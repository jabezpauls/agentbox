import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import { writePrivate } from "./paths.js";
import { execStart } from "./service-linux.js";

/**
 * Apps on this machine, for the owner's Preview (the design, "Using a machine
 * → Preview"). `agentbox-preview <port>` registers a port the agent's server
 * listens on; the node tells the gate, which shows it on the machine-apps
 * origin. Only registered ports are ever reached (never one the box names),
 * on 127.0.0.1 and then [::1].
 *
 * A registration ends when its port has not answered for 60 s, or when the
 * node restarts (it is held in memory only). At most 64 at once. Sharing one
 * publicly is not offered on machines yet.
 */

export const MAX_APPS = 64;
export const CLOSED_GRACE_MS = 60_000;
export const CHECK_MS = 5_000;

export interface Preview {
  port: number;
  name: string;
  registeredAt: number;
}

interface Held extends Preview {
  /** When its port stopped answering, or `null` while it answers. */
  closedSince: number | null;
}

/** A connection to `port` on this machine's loopback: 127.0.0.1, then [::1]. */
export function connectLocal(port: number, timeoutMs = 5_000): Promise<net.Socket> {
  const attempt = (host: string): Promise<net.Socket> =>
    new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      const timer = setTimeout(() => s.destroy(new Error("timed out")), timeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        s.off("error", reject);
        resolve(s);
      });
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  return attempt("127.0.0.1").catch(() => attempt("::1"));
}

async function answers(port: number): Promise<boolean> {
  try {
    const s = await connectLocal(port, 2_000);
    s.destroy();
    return true;
  } catch {
    return false;
  }
}

function cleanName(raw: unknown, port: number): string {
  const s = typeof raw === "string" ? raw.replace(/[^\w .()+@-]/g, "").trim().slice(0, 64) : "";
  return s || `port ${port}`;
}

export class Previews extends EventEmitter {
  private readonly apps = new Map<number, Held>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly o: { now?: () => number; probe?: (port: number) => Promise<boolean>; graceMs?: number } = {},
  ) {
    super();
  }

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  list(): Preview[] {
    return [...this.apps.values()].map(({ port, name, registeredAt }) => ({ port, name, registeredAt }));
  }

  has(port: number): boolean {
    return this.apps.has(port);
  }

  /** Register `port` (it must answer now). */
  async register(rawPort: unknown, rawName?: unknown): Promise<{ ok: true; app: Preview; existed: boolean } | { ok: false; error: string }> {
    const port = typeof rawPort === "number" ? rawPort : Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "a port is a number from 1 to 65535" };
    const existing = this.apps.get(port);
    if (!existing && this.apps.size >= MAX_APPS) return { ok: false, error: `this machine has ${MAX_APPS} apps registered already; stop one first` };
    if (!(await (this.o.probe ?? answers)(port))) return { ok: false, error: `nothing answers on port ${port} (on 127.0.0.1 or [::1]); start the server first` };
    const name = rawName === undefined && existing ? existing.name : cleanName(rawName, port);
    const app: Held = { port, name, registeredAt: existing?.registeredAt ?? this.now, closedSince: null };
    this.apps.set(port, app);
    if (!existing || existing.name !== name) this.emit("change");
    return { ok: true, app: { port, name, registeredAt: app.registeredAt }, existed: existing !== undefined };
  }

  remove(port: number): boolean {
    const had = this.apps.delete(port);
    if (had) this.emit("change");
    return had;
  }

  clear(): void {
    if (this.apps.size === 0) return;
    this.apps.clear();
    this.emit("change");
  }

  /** Probe every port; drop those closed for the grace period. */
  async check(): Promise<void> {
    let changed = false;
    for (const app of [...this.apps.values()]) {
      const up = await (this.o.probe ?? answers)(app.port);
      if (this.apps.get(app.port) !== app) continue;
      if (up) app.closedSince = null;
      else if (app.closedSince === null) app.closedSince = this.now;
      else if (this.now - app.closedSince >= (this.o.graceMs ?? CLOSED_GRACE_MS)) {
        this.apps.delete(app.port);
        changed = true;
      }
    }
    if (changed) this.emit("change");
  }

  start(everyMs = CHECK_MS): void {
    if (this.timer) return;
    let busy = false;
    this.timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.check().finally(() => (busy = false));
    }, everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** A string as one POSIX shell word. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * `agentbox-preview`, first on PATH inside the node's herdr (beside the
 * `claude` shim): this very program's `node preview`, which asks the running
 * node over its control socket.
 */
export function writePreviewShim(shims: string, command: string[] = execStart().slice(0, -2)): string {
  const file = path.join(shims, "agentbox-preview");
  writePrivate(
    file,
    `#!/bin/sh
# agentbox: show an app on this machine in the owner's Preview. Written by the node.
exec ${command.map(shQuote).join(" ")} node preview "$@"
`,
    0o700,
  );
  return file;
}
