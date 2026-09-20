import fs from "node:fs";
import type { ListeningPort } from "@workbench/shared";

/** A raw LISTEN row from `/proc/net/tcp` or `/proc/net/tcp6`. */
export interface ProcNetTcpRow {
  port: number;
  address: string;
  inode: number;
}

const LISTEN_STATE = "0A";

/** Decode the 8-hex little-endian IPv4 address `/proc` writes (e.g. `0100007F` → `127.0.0.1`). */
function decodeIpv4(hex: string): string {
  const bytes = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6), hex.slice(6, 8)].map((h) =>
    parseInt(h, 16),
  );
  return bytes.reverse().join(".");
}

/**
 * Decode the 32-hex IPv6 address `/proc` writes as four little-endian 32-bit
 * words, then compress it per RFC 5952 so `::` and `::1` come back as such.
 */
function decodeIpv6(hex: string): string {
  const bytes: number[] = [];
  for (let word = 0; word < 4; word++) {
    const chunk = hex.slice(word * 8, word * 8 + 8);
    for (let b = 3; b >= 0; b--) {
      bytes.push(parseInt(chunk.slice(b * 2, b * 2 + 2), 16));
    }
  }
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((bytes[i]! << 8) | bytes[i + 1]!);
  }
  // Find the longest run of consecutive zero groups (length >= 2) to compress.
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (runStart === -1) runStart = i;
      runLen++;
      if (runLen > bestLen) {
        bestLen = runLen;
        bestStart = runStart;
      }
    } else {
      runStart = -1;
      runLen = 0;
    }
  }
  const hextets = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hextets.join(":");
  const head = hextets.slice(0, bestStart).join(":");
  const tail = hextets.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}

/**
 * Parse a `/proc/net/tcp` or `/proc/net/tcp6` dump into its LISTEN rows only.
 * IPv4 vs IPv6 is distinguished by the width of the local-address field.
 */
export function parseProcNetTcp(text: string): ProcNetTcpRow[] {
  const rows: ProcNetTcpRow[] = [];
  for (const line of text.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    // Data rows start with an index like "0:"; the header row does not.
    if (tokens.length < 10 || !/^\d+:$/.test(tokens[0]!)) continue;
    if (tokens[3] !== LISTEN_STATE) continue;
    const [addrHex, portHex] = tokens[1]!.split(":");
    if (!addrHex || !portHex) continue;
    const port = parseInt(portHex, 16);
    const address = addrHex.length > 8 ? decodeIpv6(addrHex) : decodeIpv4(addrHex);
    const inode = Number(tokens[9]);
    rows.push({ port, address, inode });
  }
  return rows;
}

const PROC_TCP_FILES = ["/proc/net/tcp", "/proc/net/tcp6"];

function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Map socket inodes to owning pids by scanning each numeric `/proc/<pid>/fd`
 * symlink for `socket:[inode]`. Failures for processes owned by other users are
 * ignored, so
 * unmapped sockets simply come back with a null pid.
 */
function buildInodePidMap(): Map<number, number> {
  const map = new Map<number, number>();
  let pids: string[];
  try {
    pids = fs.readdirSync("/proc");
  } catch {
    return map;
  }
  for (const name of pids) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${name}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = fs.readlinkSync(`/proc/${name}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(link);
      if (match) {
        const inode = Number(match[1]);
        if (!map.has(inode)) map.set(inode, pid);
      }
    }
  }
  return map;
}

function readComm(pid: number): string | null {
  const raw = readFileOrNull(`/proc/${pid}/comm`);
  return raw ? raw.trim() || null : null;
}

/**
 * Enumerate every locally listening TCP port (IPv4 and IPv6), resolving each to
 * its owning process where `/proc` permits. Ports named in `systemPorts` are
 * flagged as infrastructure. Results are deduped by port and sorted.
 */
export async function listListeningPorts(opts: {
  systemPorts: number[];
}): Promise<ListeningPort[]> {
  const system = new Set(opts.systemPorts);
  const rows: ProcNetTcpRow[] = [];
  for (const file of PROC_TCP_FILES) {
    const text = readFileOrNull(file);
    if (text) rows.push(...parseProcNetTcp(text));
  }
  if (rows.length === 0) return [];

  const inodePid = buildInodePidMap();
  const commCache = new Map<number, string | null>();

  const byPort = new Map<number, ListeningPort>();
  for (const row of rows) {
    const pid = inodePid.get(row.inode) ?? null;
    let process: string | null = null;
    if (pid !== null) {
      if (!commCache.has(pid)) commCache.set(pid, readComm(pid));
      process = commCache.get(pid) ?? null;
    }
    const entry: ListeningPort = {
      port: row.port,
      pid,
      process,
      system: system.has(row.port),
      address: row.address,
    };
    const existing = byPort.get(row.port);
    // Prefer an entry we could attribute to a process over an anonymous one.
    if (!existing || (existing.pid === null && entry.pid !== null)) {
      byPort.set(row.port, entry);
    }
  }

  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export interface PortsWatcherOptions {
  systemPorts: number[];
  intervalMs?: number;
  /** Injectable enumerator; defaults to {@link listListeningPorts}. */
  list?: () => Promise<ListeningPort[]>;
}

/**
 * Polls listening ports on an interval and notifies listeners only when the set
 * changes. Polling runs only between {@link start} and {@link stop}, so callers
 * (the events websocket) can ref-count it against connected clients.
 */
export class PortsWatcher {
  private readonly intervalMs: number;
  private readonly list: () => Promise<ListeningPort[]>;
  private readonly listeners = new Set<(ports: ListeningPort[]) => void>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private ports: ListeningPort[] = [];
  private serialized = "";

  constructor(opts: PortsWatcherOptions) {
    this.intervalMs = opts.intervalMs ?? 2000;
    this.list = opts.list ?? (() => listListeningPorts({ systemPorts: opts.systemPorts }));
  }

  current(): ListeningPort[] {
    return this.ports;
  }

  on(listener: (ports: ListeningPort[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    // Do not keep the event loop alive solely for port polling.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const ports = await this.list();
      const serialized = JSON.stringify(ports);
      if (serialized === this.serialized) return;
      this.serialized = serialized;
      this.ports = ports;
      for (const listener of this.listeners) listener(ports);
    } catch {
      // Transient /proc read failures should not tear down the watcher.
    } finally {
      this.polling = false;
    }
  }
}
