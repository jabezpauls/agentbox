import { MAX_MACHINES } from "../link/index.js";
import { digest, newId, newSecret } from "../auth.js";
import { safeEqual } from "../context.js";
import { newUserCode, normalizeUserCode } from "../device.js";
import type { MachineJoinRecord, Store } from "../store.js";
import type { MachinesAudit } from "./audit.js";
import { cleanMachineName, MachinesFull, newNodeToken, type Registry } from "./registry.js";

/**
 * Joining a machine: a record kind of its own, apart from the CLI's device
 * logins.
 *
 * 1. The node asks to join (unauthenticated, on the box's origin) with the
 *    name it wants and what it is; it gets a secret join code to poll with and
 *    a short code to show on the machine's own screen. No link carries the
 *    code: the owner must read it there.
 * 2. The owner, signed in to machines, sees the pending join — name, platform,
 *    hostname, and the address the gate saw it from — and types the code.
 * 3. The node's next poll collects a node token, exactly once. Only then is
 *    the machine in the registry; a token minted but never collected exists
 *    only in this process's memory, and is gone with the join.
 *
 * Re-joining in place (a new token for the same machine) needs proof of the
 * old token; without it, a join is a new machine.
 */

export const JOIN_TTL_MS = 10 * 60_000;
export const JOIN_POLL_S = 3;
/** Joins waiting at once, from everyone together. */
export const MAX_PENDING_JOINS = 3;

export class JoinRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type JoinPoll =
  | { status: "pending" }
  | { status: "approved"; token: string; machineId: string; name: string }
  | { status: "denied" | "expired" };

/** A pending join as the Admin page lists it: never its codes. */
export interface JoinView {
  id: string;
  name: string;
  platform: string;
  arch: string;
  hostname: string;
  ip: string;
  createdAt: number;
  expiresAt: number;
  rejoinOf: string | null;
}

function short(raw: unknown, max: number): string {
  return (typeof raw === "string" ? raw : "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

export class Joins {
  /** Approved joins' tokens, until collected. */
  private readonly minted = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private readonly registry: Registry,
    private readonly audit: MachinesAudit,
    private readonly now: () => number = Date.now,
  ) {}

  private get list(): MachineJoinRecord[] {
    return this.store.data.machines.joins;
  }

  async start(req: {
    name: unknown;
    platform: unknown;
    arch: unknown;
    hostname: unknown;
    ip: string;
    rejoin?: { machineId?: unknown; token?: unknown } | undefined;
  }): Promise<{ joinCode: string; userCode: string; expiresIn: number; interval: number; name: string }> {
    await this.prune();
    if (this.list.filter((j) => j.status === "pending").length >= MAX_PENDING_JOINS) {
      throw new JoinRefused(`${MAX_PENDING_JOINS} machines are already waiting to join; approve, deny or let them expire (10 minutes)`, 429);
    }
    let rejoinOf: string | null = null;
    if (req.rejoin !== undefined) {
      // Proof of the old token: the token itself, over the same TLS the link
      // would carry it on. A wrong one is refused, not quietly made a new machine.
      const token = typeof req.rejoin.token === "string" ? req.rejoin.token : "";
      const rec = this.registry.byToken(token);
      if (!rec || rec.id !== req.rejoin.machineId || rec.state !== "active") {
        throw new JoinRefused("this box does not know that machine's old token; join it as a new machine", 409);
      }
      rejoinOf = rec.id;
    } else if (this.registry.activeCount() >= MAX_MACHINES) {
      throw new JoinRefused(`this box has ${MAX_MACHINES} machines already; remove one first`, 409);
    }
    const t = this.now();
    const joinCode = newSecret();
    let userCode = newUserCode();
    while (this.list.some((j) => j.userCode === userCode)) userCode = newUserCode();
    const record: MachineJoinRecord = {
      id: newId(),
      hash: digest(joinCode),
      userCode,
      name: rejoinOf ? (this.registry.get(rejoinOf)?.name ?? "machine") : cleanMachineName(req.name),
      platform: short(req.platform, 32),
      arch: short(req.arch, 32),
      hostname: short(req.hostname, 253),
      ip: req.ip,
      createdAt: t,
      expiresAt: t + JOIN_TTL_MS,
      status: "pending",
      rejoinOf,
    };
    this.list.push(record);
    await this.store.save();
    this.audit.record("join-requested", { name: record.name, ip: req.ip, detail: rejoinOf ? `re-join of ${rejoinOf}` : record.hostname, ...(rejoinOf ? { machineId: rejoinOf } : {}) });
    return { joinCode, userCode, expiresIn: JOIN_TTL_MS / 1000, interval: JOIN_POLL_S, name: record.name };
  }

  pending(): JoinView[] {
    const t = this.now();
    return this.list
      .filter((j) => j.status === "pending" && j.expiresAt > t)
      .map(({ id, name, platform, arch, hostname, ip, createdAt, expiresAt, rejoinOf }) => ({ id, name, platform, arch, hostname, ip, createdAt, expiresAt, rejoinOf }));
  }

  /** The owner typed `code`: the pending join it names is approved, or `null` (no such code). */
  async approve(code: string, ip: string): Promise<MachineJoinRecord | null> {
    const normal = normalizeUserCode(code);
    if (normal === null) return null;
    const t = this.now();
    const rec = this.list.find((j) => j.status === "pending" && j.expiresAt > t && safeEqual(j.userCode, normal));
    if (!rec) return null;
    // Claimed before any await, so one code can never mint two tokens.
    rec.status = "approved";
    this.minted.set(rec.id, newNodeToken());
    await this.store.save();
    this.audit.record("join-approved", { name: rec.name, ip, detail: `asked from ${rec.ip}`, ...(rec.rejoinOf ? { machineId: rec.rejoinOf } : {}) });
    return rec;
  }

  async deny(id: string, ip: string): Promise<MachineJoinRecord | null> {
    const rec = this.list.find((j) => j.id === id && j.status === "pending");
    if (!rec) return null;
    rec.status = "denied";
    await this.store.save();
    this.audit.record("join-denied", { name: rec.name, ip, detail: `asked from ${rec.ip}` });
    return rec;
  }

  async poll(joinCode: string, ip: string): Promise<JoinPoll> {
    if (typeof joinCode !== "string" || joinCode === "") return { status: "expired" };
    const hash = digest(joinCode);
    const rec = this.list.find((j) => safeEqual(j.hash, hash));
    if (!rec || rec.expiresAt <= this.now()) {
      if (rec) await this.forget(rec);
      return { status: "expired" };
    }
    if (rec.status === "pending") return { status: "pending" };
    if (rec.status === "denied") {
      await this.forget(rec);
      return { status: "denied" };
    }
    const token = this.minted.get(rec.id);
    // Collected once: whatever happens next, this join is spent.
    await this.forget(rec);
    if (token === undefined) return { status: "expired" };
    const reported = { platform: rec.platform, arch: rec.arch, hostname: rec.hostname };
    if (rec.rejoinOf) {
      const machine = await this.registry.replaceToken(rec.rejoinOf, token, reported);
      if (!machine) return { status: "expired" };
      this.audit.record("rejoined", { machineId: machine.id, name: machine.name, ip });
      return { status: "approved", token, machineId: machine.id, name: machine.name };
    }
    try {
      const machine = await this.registry.create({ name: rec.name, token, joinIp: rec.ip, reported });
      this.audit.record("token-issued", { machineId: machine.id, name: machine.name, ip });
      return { status: "approved", token, machineId: machine.id, name: machine.name };
    } catch (err) {
      if (err instanceof MachinesFull) return { status: "denied" };
      throw err;
    }
  }

  /** Drop expired joins; a token minted for one never collected goes with it. */
  async prune(): Promise<void> {
    const t = this.now();
    const expired = this.list.filter((j) => j.expiresAt <= t);
    if (expired.length === 0) return;
    for (const j of expired) this.minted.delete(j.id);
    this.store.data.machines.joins = this.list.filter((j) => j.expiresAt > t);
    await this.store.save();
  }

  private async forget(rec: MachineJoinRecord): Promise<void> {
    this.minted.delete(rec.id);
    this.store.data.machines.joins = this.list.filter((j) => j.id !== rec.id);
    await this.store.save();
  }
}
