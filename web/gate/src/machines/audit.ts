import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The machines audit log: what happened to which machine, in files of its own
 * on the gate's volume, append-only (one JSON object per line).
 *
 * Everything goes to `machines-audit.log`, which is rotated past 1 MiB into
 * `machines-audit.log.1` (one generation). Joins, revocations, removals and
 * every token event also go to `machines-audit-keep.log`, which is never
 * rotated, so the record of who was let in, and when, outlives any amount of
 * online/offline chatter.
 */

export const AUDIT_FILE = "machines-audit.log";
export const AUDIT_KEEP_FILE = "machines-audit-keep.log";
export const AUDIT_ROTATE_BYTES = 1024 * 1024;

export type AuditKind =
  | "join-requested"
  | "join-approved"
  | "join-denied"
  | "token-issued"
  | "rejoined"
  | "online"
  | "offline"
  | "paused"
  | "duplicate"
  | "upgrade"
  | "revoked"
  | "removed"
  | "left"
  | "claude-token"
  | "opt-in"
  | "presence";

/** Never rotated out. */
const KEPT = new Set<AuditKind>(["join-approved", "join-denied", "token-issued", "rejoined", "revoked", "removed", "left", "claude-token", "opt-in"]);

export interface AuditEvent {
  id: string;
  at: number;
  kind: AuditKind;
  machineId?: string;
  name?: string;
  ip?: string;
  detail?: string;
}

export class MachinesAudit {
  private readonly file: string;
  private readonly keepFile: string;

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
    private readonly rotateBytes = AUDIT_ROTATE_BYTES,
  ) {
    this.file = path.join(dataDir, AUDIT_FILE);
    this.keepFile = path.join(dataDir, AUDIT_KEEP_FILE);
  }

  record(kind: AuditKind, fields: Omit<AuditEvent, "id" | "at" | "kind"> = {}): AuditEvent {
    const event: AuditEvent = { id: randomBytes(8).toString("hex"), at: this.now(), kind, ...fields };
    const line = `${JSON.stringify(event)}\n`;
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      if (KEPT.has(kind)) fs.appendFileSync(this.keepFile, line, { mode: 0o600 });
    } catch (err) {
      // An audit write that fails must not take the link down; it is said.
      console.error(`[gate] machines audit write failed: ${(err as Error).message}`);
    }
    return event;
  }

  /** The newest `limit` events, newest first. */
  list(limit = 200): AuditEvent[] {
    const seen = new Map<string, AuditEvent>();
    for (const f of [this.keepFile, `${this.file}.1`, this.file]) {
      let text: string;
      try {
        text = fs.readFileSync(f, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as AuditEvent;
          if (typeof e.id === "string" && typeof e.at === "number") seen.set(e.id, e);
        } catch {
          // A torn last line from a crash: skipped.
        }
      }
    }
    // Read oldest to newest; reversed first, so events of the same millisecond stay newest first.
    return [...seen.values()].reverse().sort((a, b) => b.at - a.at).slice(0, limit);
  }

  private rotateIfNeeded(): void {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size >= this.rotateBytes) fs.renameSync(this.file, `${this.file}.1`);
  }
}
