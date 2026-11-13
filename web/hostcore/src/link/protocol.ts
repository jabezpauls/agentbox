import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * What the gate and a node say to each other over the link's control channel
 * (frame.ts). The node speaks first, once: its hello. The gate answers with
 * one of
 *
 *   ok         the link is up (with the machine's id and name)
 *   upgrade    this node is too old to be served; `minimum` says what is needed
 *   duplicate  another link for this machine still answers; back off 5 minutes
 *   revoked    the owner revoked this machine; signed (below), so nothing but
 *              this machine's own gate can say it
 *
 * Afterwards the node may say `policy` (its policy summary changed), `pause`
 * (the owner paused it here; the link closes next), `leave` (it is leaving)
 * or `apps` (its whole list of registered apps, `[{port, name}]`, at most 64:
 * on every link up and every change). Nothing else a node says does anything.
 */

export const PROTOCOL_VERSION = 1;
/** The oldest protocol the gate serves. */
export const MIN_PROTOCOL_VERSION = 1;

export const LINK_PATH = "/_gate/node";

/** Per link, control messages from the node at most this many a second. */
export const CONTROL_PER_SECOND = 20;
/** Machines per box; streams per link. */
export const MAX_MACHINES = 32;
export const MAX_STREAMS_PER_LINK = 256;
/** WebSocket pings, each way; two missed in a row and the link is dead. */
export const PING_MS = 25_000;
export const MISSED_PINGS = 2;
/** A duplicate link backs off this long. */
export const DUPLICATE_BACKOFF_MS = 5 * 60_000;
/** A first link that does not answer a ping within this is stale, and replaced. */
export const STALE_PONG_MS = 5_000;
/** The node must say hello within this of connecting. */
export const HELLO_TIMEOUT_MS = 10_000;

/** A node token: `abn_` and 256 random bits. Accepted on the link and nowhere else. */
export const NODE_TOKEN_PREFIX = "abn_";
export const NODE_TOKEN_SHAPE = /^abn_[A-Za-z0-9_-]{43}$/;

export type FileMode = "read" | "write";

/** What the policy allows, as the node reports it (never more than the node enforces). */
export interface PolicySummary {
  terminals: boolean;
  files: Array<{ path: string; mode: FileMode }>;
  ports: boolean;
  share: boolean;
  updates: "auto" | "notify" | "off";
  presenceHours: number;
  paused: boolean;
  /** Why everything is denied (a missing or broken policy.json), or `null`. */
  problem: string | null;
}

export interface Hello {
  type: "hello";
  protocol: number;
  /** The node's own version. */
  version: string;
  /** 32 random bytes, base64url: what the gate's `revoked` is bound to. */
  nonce: string;
  platform: string;
  arch: string;
  hostname: string;
  cpu: { model: string; cores: number };
  ramBytes: number;
  disks: Array<{ path: string; freeBytes: number }>;
  gpus: Array<{ name: string; memoryMiB: number | null }>;
  docker: boolean;
  /** Claude Code's version on the machine, when it is there. */
  claude: string | null;
  policy: PolicySummary;
}

export type GateAnswer =
  | { type: "ok"; machineId: string; name: string }
  | { type: "upgrade"; minimum: number; message: string }
  | { type: "duplicate"; retryAfterMs: number; message: string }
  | { type: "revoked"; machineId: string; mac: string };

const MAX_TEXT = 200;
const MAX_LIST = 32;

function text(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== "string") return null;
  // Printable only: these are shown to the owner.
  return v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/** The policy summary in `v`, or `null` when it is not one. */
export function parsePolicySummary(v: unknown): PolicySummary | null {
  if (typeof v !== "object" || v === null) return null;
  const p = v as Record<string, unknown>;
  if (!Array.isArray(p.files) || p.files.length > MAX_LIST) return null;
  const files: PolicySummary["files"] = [];
  for (const f of p.files as unknown[]) {
    const path = text((f as { path?: unknown })?.path, 1024);
    const mode = (f as { mode?: unknown })?.mode;
    if (path === null || (mode !== "read" && mode !== "write")) return null;
    files.push({ path, mode });
  }
  const updates = p.updates;
  if (updates !== "auto" && updates !== "notify" && updates !== "off") return null;
  const hours = count(p.presenceHours);
  if (hours === null) return null;
  const problem = p.problem === null ? null : text(p.problem, 500);
  if (problem === null && p.problem !== null) return null;
  for (const k of ["terminals", "ports", "share", "paused"]) if (typeof p[k] !== "boolean") return null;
  return {
    terminals: p.terminals as boolean,
    files,
    ports: p.ports as boolean,
    share: p.share as boolean,
    updates,
    presenceHours: hours,
    paused: p.paused as boolean,
    problem,
  };
}

/**
 * The hello in a control message, cleaned (strings bounded and printable,
 * lists bounded, unknown fields dropped), or why it is refused.
 */
export function parseHello(m: Record<string, unknown>): Hello | string {
  if (m.type !== "hello") return "the first message must be hello";
  const protocol = count(m.protocol);
  if (protocol === null) return "hello: protocol";
  const version = text(m.version, 64);
  const nonce = typeof m.nonce === "string" && /^[A-Za-z0-9_-]{43}$/.test(m.nonce) ? m.nonce : null;
  if (!version) return "hello: version";
  if (!nonce) return "hello: nonce";
  const platform = text(m.platform, 32);
  const arch = text(m.arch, 32);
  const hostname = text(m.hostname, 253);
  if (platform === null || arch === null || hostname === null) return "hello: platform, arch, hostname";
  const cpuRaw = (m.cpu ?? {}) as Record<string, unknown>;
  const cpu = { model: text(cpuRaw.model) ?? "", cores: count(cpuRaw.cores) ?? 0 };
  const ramBytes = count(m.ramBytes) ?? 0;
  const disks: Hello["disks"] = [];
  for (const d of Array.isArray(m.disks) ? (m.disks as unknown[]).slice(0, MAX_LIST) : []) {
    const r = (d ?? {}) as Record<string, unknown>;
    const path = text(r.path, 1024);
    const free = count(r.freeBytes);
    if (path !== null && free !== null) disks.push({ path, freeBytes: free });
  }
  const gpus: Hello["gpus"] = [];
  for (const g of Array.isArray(m.gpus) ? (m.gpus as unknown[]).slice(0, MAX_LIST) : []) {
    const r = (g ?? {}) as Record<string, unknown>;
    const name = text(r.name);
    if (name) gpus.push({ name, memoryMiB: count(r.memoryMiB) });
  }
  const policy = parsePolicySummary(m.policy);
  if (!policy) return "hello: policy";
  return {
    type: "hello",
    protocol,
    version,
    nonce,
    platform,
    arch,
    hostname,
    cpu,
    ramBytes,
    disks,
    gpus,
    docker: m.docker === true,
    claude: m.claude === null || m.claude === undefined ? null : text(m.claude, 64),
    policy,
  };
}

/** SHA-256 of a token, hex: what the gate stores, and what the node can work out from the token it holds. */
export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The `revoked` message's signature: an HMAC keyed by the token's digest,
 * which only this machine's gate holds (beside the node, which holds the
 * token), over the machine id and the nonce of this link's hello — so it
 * cannot be replayed onto another link, or made by anyone without the store.
 */
export function revokeMac(tokenDigestHex: string, machineId: string, nonce: string): string {
  return createHmac("sha256", tokenDigestHex).update(`agentbox-revoked\n${machineId}\n${nonce}`).digest("hex");
}

export function verifyRevoke(token: string, machineId: string, nonce: string, mac: unknown): boolean {
  if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) return false;
  const want = Buffer.from(revokeMac(tokenDigest(token), machineId, nonce), "hex");
  return timingSafeEqual(want, Buffer.from(mac, "hex"));
}
