import { randomBytes } from "node:crypto";
import { MAX_MACHINES, NODE_TOKEN_PREFIX, NODE_TOKEN_SHAPE, type Hello } from "../link/index.js";
import { digest, newId } from "../auth.js";
import { safeEqual } from "../context.js";
import type { MachineRecord, MachineSpecs, Store } from "../store.js";

/**
 * The machines joined to this box, in the gate's store. A machine is added
 * only by a join the owner approved with the code it showed (joins.ts), and
 * holds one node token, kept as a digest, which opens its link and nothing
 * else (link.ts).
 *
 * Whether a machine is online is the link hub's to say; the registry keeps
 * what lasts: its name, its last hello's specs, when it was last seen.
 */

export class MachinesFull extends Error {}

/** A name as the URL never uses it but the owner reads it: lower case, `a-z0-9.-_`, at most 40. */
export function cleanMachineName(raw: unknown): string {
  const s = (typeof raw === "string" ? raw : "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 40);
  return s === "" ? "machine" : s;
}

export function newNodeToken(): string {
  return `${NODE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** A machine as the machines UI sees it: never its token's digest. */
export interface MachineView {
  id: string;
  name: string;
  state: "online" | "offline" | "paused" | "revoked" | "left";
  createdAt: number;
  joinIp: string;
  reported: MachineRecord["reported"];
  specs: MachineSpecs | null;
  lastSeenAt: number | null;
  lastIp: string | null;
  revokedAt: number | null;
  /** A second link for it was refused while this one answered (the newest such time). */
  duplicateAt: number | null;
  /** The gate asked it to update (its protocol is too old). */
  upgradeNeeded: boolean;
  optIns: MachineRecord["optIns"];
}

export class Registry {
  /** Bookkeeping that lasts only while the gate runs. */
  private readonly duplicates = new Map<string, number>();
  private readonly upgrades = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  private get nodes(): MachineRecord[] {
    return this.store.data.machines.nodes;
  }

  all(): MachineRecord[] {
    return this.nodes;
  }

  get(id: string): MachineRecord | null {
    return this.nodes.find((n) => n.id === id) ?? null;
  }

  /** The machine a node token belongs to, in whatever state; `null` for anything else. */
  byToken(token: string): MachineRecord | null {
    if (!NODE_TOKEN_SHAPE.test(token)) return null;
    const hash = digest(token);
    return this.nodes.find((n) => safeEqual(n.tokenHash, hash)) ?? null;
  }

  activeCount(): number {
    return this.nodes.filter((n) => n.state === "active").length;
  }

  /** `name`, or `name-2`, `name-3`, … : the first no other machine has. */
  uniqueName(name: string, except: string | null = null): string {
    const taken = new Set(this.nodes.filter((n) => n.id !== except).map((n) => n.name));
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) {
      const candidate = `${name.slice(0, 36)}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  async create(opts: { name: string; token: string; joinIp: string; reported: MachineRecord["reported"] }): Promise<MachineRecord> {
    if (this.activeCount() >= MAX_MACHINES) throw new MachinesFull(`this box has ${MAX_MACHINES} machines already; remove one first`);
    const record: MachineRecord = {
      id: newId(),
      name: this.uniqueName(cleanMachineName(opts.name)),
      tokenHash: digest(opts.token),
      state: "active",
      createdAt: this.now(),
      joinIp: opts.joinIp,
      reported: opts.reported,
      specs: null,
      lastSeenAt: null,
      lastIp: null,
      pausedAt: null,
      revokedAt: null,
      leftAt: null,
      optIns: { claudeToken: false },
    };
    this.nodes.push(record);
    await this.store.save();
    return record;
  }

  /** Re-joined in place: the same machine, a new token; the old one stops working now. */
  async replaceToken(id: string, token: string, reported: MachineRecord["reported"]): Promise<MachineRecord | null> {
    const rec = this.get(id);
    if (!rec || rec.state !== "active") return null;
    rec.tokenHash = digest(token);
    rec.reported = reported;
    await this.store.save();
    return rec;
  }

  /** Its link said hello: what it reports, from where. */
  hello(rec: MachineRecord, hello: Hello, ip: string): void {
    const { version, protocol, platform, arch, hostname, cpu, ramBytes, disks, gpus, docker, claude, policy } = hello;
    rec.specs = { version, protocol, platform, arch, hostname, cpu, ramBytes, disks, gpus, docker, claude, policy };
    rec.lastSeenAt = this.now();
    rec.lastIp = ip;
    rec.pausedAt = null;
    this.upgrades.delete(rec.id);
    this.store.saveSoon();
  }

  policy(rec: MachineRecord, policy: MachineSpecs["policy"]): void {
    if (rec.specs) rec.specs.policy = policy;
    this.store.saveSoon();
  }

  seen(rec: MachineRecord): void {
    rec.lastSeenAt = this.now();
    this.store.saveSoon();
  }

  paused(rec: MachineRecord): void {
    rec.pausedAt = this.now();
    this.store.saveSoon();
  }

  duplicate(id: string): void {
    this.duplicates.set(id, this.now());
  }

  upgradeNeeded(id: string): void {
    this.upgrades.add(id);
  }

  async revoke(id: string): Promise<MachineRecord | null> {
    const rec = this.get(id);
    if (!rec || rec.state === "revoked") return rec;
    rec.state = "revoked";
    rec.revokedAt = this.now();
    await this.store.save();
    return rec;
  }

  async left(id: string): Promise<void> {
    const rec = this.get(id);
    if (!rec) return;
    rec.state = "left";
    rec.leftAt = this.now();
    await this.store.save();
  }

  /** Forgotten: its token, revoked or not, is unknown from now on. */
  async remove(id: string): Promise<MachineRecord | null> {
    const rec = this.get(id);
    if (!rec) return null;
    this.store.data.machines.nodes = this.nodes.filter((n) => n.id !== id);
    this.duplicates.delete(id);
    this.upgrades.delete(id);
    await this.store.save();
    return rec;
  }

  view(rec: MachineRecord, online: boolean): MachineView {
    const state: MachineView["state"] =
      rec.state === "revoked" ? "revoked" : rec.state === "left" ? "left" : online ? "online" : rec.pausedAt !== null ? "paused" : "offline";
    return {
      id: rec.id,
      name: rec.name,
      state,
      createdAt: rec.createdAt,
      joinIp: rec.joinIp,
      reported: rec.reported,
      specs: rec.specs,
      lastSeenAt: rec.lastSeenAt,
      lastIp: rec.lastIp,
      revokedAt: rec.revokedAt,
      duplicateAt: this.duplicates.get(rec.id) ?? null,
      upgradeNeeded: this.upgrades.has(rec.id),
      optIns: rec.optIns,
    };
  }
}
