import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PolicySummary } from "./link/index.js";

/**
 * The gate's state: everything that decides who gets in. One JSON file on the
 * gate's own volume, which no sandbox container mounts — the first of the two
 * rules. The bridge runs as the same user as every agent, so nothing here could
 * live there.
 *
 * Writes are atomic (a temporary file, fsync, rename, fsync of the directory),
 * so a crash or a full disk leaves either the old file or the new one, never a
 * torn one that would lock the owner out. Credentials are never stored in the
 * clear: session cookies and device tokens as SHA-256 digests, the password as
 * bcrypt, recovery codes as SHA-256 digests of 80-bit codes.
 */

export const STORE_VERSION = 1;
export const STORE_FILE = "gate.json";

export interface PasswordRecord {
  hash: string;
  updatedAt: number;
}

export interface SessionRecord {
  /**
   * Whose session: the box's (`main`). Absent in sessions made before
   * machines, which are the box's too. A machines session is never one of
   * these: it lives in `machines.sessions`, under a cookie of its own.
   */
  aud?: "main";
  /** A handle for listing and ending the session; not a credential. */
  id: string;
  /** SHA-256 of the cookie's secret. */
  hash: string;
  createdAt: number;
  lastSeenAt: number;
  /** The absolute end, however active the session stays. */
  expiresAt: number;
  /** "Remember this device": no idle timeout, a persistent cookie. */
  remember: boolean;
  ip: string;
  userAgent: string;
}

/**
 * A session on the machines origin: opened with a live main session and the
 * machines passphrase (machines/session.ts), and accepted nowhere else. Kept
 * apart from the box's sessions, so nothing that reads those — an older gate
 * included — can mistake one for the other.
 */
export interface MachinesSessionRecord {
  aud: "machines";
  id: string;
  /** SHA-256 of the cookie's secret. */
  hash: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string;
  userAgent: string;
}

/** What a machine said about itself in its last hello (protocol.ts's Hello, without the link's nonce). */
export interface MachineSpecs {
  version: string;
  protocol: number;
  platform: string;
  arch: string;
  hostname: string;
  cpu: { model: string; cores: number };
  ramBytes: number;
  disks: Array<{ path: string; freeBytes: number }>;
  gpus: Array<{ name: string; memoryMiB: number | null }>;
  docker: boolean;
  claude: string | null;
  policy: PolicySummary;
}

/**
 * A joined machine (machines/registry.ts). Its node token is kept as a
 * digest only. A revoked machine keeps its record — and its digest — so its
 * next link can be told, signed, that it is revoked; removing it forgets both.
 */
export interface MachineRecord {
  id: string;
  name: string;
  /** SHA-256 of the `abn_` node token. */
  tokenHash: string;
  state: "active" | "revoked" | "left";
  createdAt: number;
  /** The address the join was asked for from, as the gate saw it. */
  joinIp: string;
  /** What the machine reported when it asked to join. */
  reported: { platform: string; arch: string; hostname: string };
  specs: MachineSpecs | null;
  lastSeenAt: number | null;
  lastIp: string | null;
  /** Paused on the machine (`agentbox node pause`); cleared by its next hello. */
  pausedAt: number | null;
  revokedAt: number | null;
  leftAt: number | null;
  /** What the owner opted this machine in to (phase 4: the shared Claude token). */
  optIns: { claudeToken: boolean };
  /** The shared Claude token's generation last sent to it (`null`: none, or wiped). */
  claudeTokenGeneration?: number | null;
}

/** A machine asking to join (machines/joins.ts): a record kind of its own, apart from device logins. */
export interface MachineJoinRecord {
  id: string;
  /** SHA-256 of the join code the node polls with. */
  hash: string;
  /** What the machine shows and the owner types, `XXXX-XXXX`. Never listed. */
  userCode: string;
  name: string;
  platform: string;
  arch: string;
  hostname: string;
  ip: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied";
  /** Re-joining in place: the machine whose old node token the request proved. */
  rejoinOf: string | null;
}

export interface MachinesData {
  /** The machines passphrase, bcrypt; set on the host only (`agentbox machines enable`). */
  passphrase: PasswordRecord | null;
  /** Bumped when the passphrase changes, so a sign-in checked against the old one is refused. */
  generation: number;
  sessions: MachinesSessionRecord[];
  nodes: MachineRecord[];
  joins: MachineJoinRecord[];
}

export interface TokenRecord {
  id: string;
  name: string;
  /** SHA-256 of the `abx_` token. */
  hash: string;
  createdAt: number;
  lastUsedAt: number | null;
  lastIp: string | null;
}

export interface DeviceCodeRecord {
  id: string;
  /** SHA-256 of the device code the CLI polls with. */
  hash: string;
  /** What the owner confirms on the approval page, `XXXX-XXXX`. */
  userCode: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  ip: string;
  /** What the per-client cap counts against (the address, or its /64). */
  key?: string;
  status: "pending" | "approved" | "denied";
  /** The token minted on approval, until the CLI collects it. */
  tokenId: string | null;
}

export interface TotpRecord {
  /** Base32 secret of the enrolled authenticator; `null` when two-factor is off. */
  secret: string | null;
  enabledAt: number | null;
  /** An enrolment started but not yet confirmed with a code. */
  pending: { secret: string; createdAt: number } | null;
  /** The last time step a code was accepted for, so a code works once. */
  lastStep: number;
  /** SHA-256 digests of the unused recovery codes. */
  recoveryCodes: string[];
}

/**
 * An app: a server in the sandbox, reached at `/a/<id>/`. The same shape as
 * `App` in `web/shared` (which the gate does not import: its image builds
 * nothing else), plus what stays in the gate — the passcode's hash and the
 * sharing epoch.
 */
export interface AppRecord {
  id: string;
  name: string;
  port: number;
  keepPrefix: boolean;
  cwd?: string;
  command?: string;
  pinned: boolean;
  createdBy: "owner" | "agent";
  createdAt: number;
  visibility: {
    mode: "private" | "link" | "passcode";
    expiresAt: number | null;
    /** bcrypt, for `passcode`. */
    passcodeHash?: string;
    sharedAt?: number;
    /**
     * Bumped whenever what a passcode unlocked stops being true (a new
     * passcode, stopping sharing, expiry): every grant minted by a passcode
     * names the epoch it was minted in, and one from an older epoch is void.
     */
    epoch: number;
  };
  compat: "auto" | "off";
}

export interface StoreData {
  version: number;
  /**
   * Bumped whenever the credentials change (the password, two-factor). A
   * sign-in that checked the old ones while they changed sees a different
   * number when it finishes, and is refused rather than surviving the change.
   */
  generation: number;
  password: PasswordRecord | null;
  sessions: SessionRecord[];
  totp: TotpRecord;
  deviceCodes: DeviceCodeRecord[];
  tokens: TokenRecord[];
  apps: AppRecord[];
  /**
   * The key app grants are signed with (base64url, 256 bits), made on first
   * use. Kept in the store so a restart does not void every grant.
   */
  appKey: string | null;
  machines: MachinesData;
}

export function emptyMachines(): MachinesData {
  return { passphrase: null, generation: 0, sessions: [], nodes: [], joins: [] };
}

export function emptyTotp(): TotpRecord {
  return { secret: null, enabledAt: null, pending: null, lastStep: 0, recoveryCodes: [] };
}

function emptyData(): StoreData {
  return {
    version: STORE_VERSION,
    generation: 0,
    password: null,
    sessions: [],
    totp: emptyTotp(),
    deviceCodes: [],
    tokens: [],
    apps: [],
    appKey: null,
    machines: emptyMachines(),
  };
}

export class StoreError extends Error {}

/** A bcrypt hash in any of the variants Caddy, Go and Node write. */
export function isBcryptHash(value: string): boolean {
  return /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}

function parse(text: string, file: string): StoreData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new StoreError(`${file} is not valid JSON; refusing to start rather than overwrite it`);
  }
  if (typeof raw !== "object" || raw === null) throw new StoreError(`${file} is not a gate store`);
  const data = raw as Partial<StoreData>;
  if (typeof data.version !== "number") throw new StoreError(`${file} has no schema version`);
  if (data.version > STORE_VERSION) {
    // Written by a newer gate. Rewriting it in an older shape would drop what
    // that version added, so an accidental downgrade stops here instead.
    throw new StoreError(`${file} is schema v${data.version}; this gate understands up to v${STORE_VERSION}`);
  }
  const base = emptyData();
  return {
    version: STORE_VERSION,
    generation: typeof data.generation === "number" ? data.generation : 0,
    password: data.password ?? null,
    sessions: Array.isArray(data.sessions) ? data.sessions : base.sessions,
    totp: { ...base.totp, ...(data.totp ?? {}) },
    deviceCodes: Array.isArray(data.deviceCodes) ? data.deviceCodes : base.deviceCodes,
    tokens: Array.isArray(data.tokens) ? data.tokens : base.tokens,
    apps: Array.isArray(data.apps) ? data.apps : base.apps,
    appKey: typeof data.appKey === "string" ? data.appKey : null,
    machines: parseMachines(data.machines),
  };
}

function parseMachines(raw: unknown): MachinesData {
  const m = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<MachinesData>;
  return {
    passphrase: m.passphrase && typeof m.passphrase.hash === "string" ? m.passphrase : null,
    generation: typeof m.generation === "number" ? m.generation : 0,
    sessions: Array.isArray(m.sessions) ? m.sessions.filter((s) => s?.aud === "machines") : [],
    nodes: Array.isArray(m.nodes) ? m.nodes.filter((n) => typeof n?.id === "string" && typeof n.tokenHash === "string") : [],
    joins: Array.isArray(m.joins) ? m.joins.filter((j) => typeof j?.id === "string" && typeof j.hash === "string") : [],
  };
}

/** Replace `file` with `contents` so that a reader only ever sees one or the other whole. */
export async function writeAtomic(file: string, contents: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fh = await fs.open(tmp, "w", 0o600);
  try {
    await fh.writeFile(contents);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  // The rename is only durable once the directory entry is.
  const dir = await fs.open(path.dirname(file), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

export class Store {
  private writing: Promise<void> | null = null;
  private dirty = false;
  private soon: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    readonly file: string,
    public data: StoreData,
  ) {}

  /**
   * Open the store in `dir`, creating it when absent. A store without a
   * password takes `seedHash` (from `AGENTBOX_PASSWORD_HASH`): that is the only
   * thing the environment decides, and only once.
   */
  static async open(dir: string, seedHash: string | null, now = Date.now()): Promise<Store> {
    const file = path.join(dir, STORE_FILE);
    let data: StoreData;
    let created = false;
    try {
      data = parse(await fs.readFile(file, "utf8"), file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      data = emptyData();
      created = true;
    }
    const store = new Store(file, data);
    let changed = created;
    if (data.password === null && seedHash) {
      if (isBcryptHash(seedHash)) {
        data.password = { hash: seedHash, updatedAt: now };
        changed = true;
      } else {
        console.warn("[gate] AGENTBOX_PASSWORD_HASH is not a bcrypt hash; ignoring it");
      }
    }
    if (changed) await store.save();
    return store;
  }

  /** The app registry. */
  get apps(): AppRecord[] {
    return this.data.apps;
  }

  /**
   * Persist the current state. Calls made while a write is in flight are
   * folded into one more write after it, and every caller's promise resolves
   * only once a write that includes its change has landed.
   */
  save(): Promise<void> {
    this.dirty = true;
    if (!this.writing) this.writing = this.drain();
    return this.writing;
  }

  /**
   * Persist within a few seconds, for bookkeeping that may be lost in a crash
   * without harm (a session's last-seen time). Keeps a busy session from
   * becoming a disk write per request.
   */
  saveSoon(delayMs = 5_000): void {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      this.save().catch((err: unknown) => console.error("[gate] store write failed", err));
    }, delayMs);
    this.soon.unref?.();
  }

  /** Write anything pending; used on shutdown. */
  async flush(): Promise<void> {
    if (this.soon) {
      clearTimeout(this.soon);
      this.soon = null;
      await this.save();
    } else if (this.writing) {
      await this.writing;
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.dirty) {
        this.dirty = false;
        await writeAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
      }
    } finally {
      // Cleared in the same turn the loop sees nothing left to write, so a
      // save() arriving any later starts a fresh drain rather than joining one
      // that has already finished.
      this.writing = null;
    }
  }
}
