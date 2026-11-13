import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { MACHINE_APP_COOKIE } from "../cookies.js";

/**
 * Machine apps: what the nodes registered with `agentbox-preview`, served on
 * the machine-apps origin at `/<app id>/` (app-gateway.ts). A registry of its
 * own, separate from the box's (apps.ts): the sandbox's app API (`:7901`) and
 * the main origin's `/_gate/apps` never see it, and nothing here is stored —
 * a node sends its whole list on every link up and every change, and a
 * machine that goes offline has none until it says so again.
 *
 * An app's id is 128 random bits, kept for the same machine and port while
 * the gate runs, so a Preview open across a reconnect keeps its address.
 */

export const MAX_APPS_PER_MACHINE = 64;
export const APP_ID = /^[0-9a-f]{32}$/;

export interface MachineApp {
  id: string;
  machineId: string;
  port: number;
  name: string;
  registeredAt: number;
}

export type MachineAppsChange = { kind: "removed"; ids: string[] };

function cleanName(v: unknown, port: number): string {
  const s = typeof v === "string" ? v.replace(/[^\w .()+@-]/g, "").trim().slice(0, 64) : "";
  return s || `port ${port}`;
}

/** A node's list, cleaned: at most 64, each port once, names printable and short. */
export function parseAppList(raw: unknown): Array<{ port: number; name: string }> | null {
  if (!Array.isArray(raw) || raw.length > MAX_APPS_PER_MACHINE) return null;
  const out = new Map<number, string>();
  for (const a of raw as unknown[]) {
    const port = (a as { port?: unknown } | null)?.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    out.set(port, cleanName((a as { name?: unknown }).name, port));
  }
  return [...out].map(([port, name]) => ({ port, name }));
}

export class MachineApps {
  private readonly byId = new Map<string, MachineApp>();
  private readonly byMachine = new Map<string, Map<number, MachineApp>>();
  /** `<machine>:<port>` → id, kept across a machine's lists. */
  private readonly ids = new Map<string, string>();
  private readonly listeners = new Set<(c: MachineAppsChange) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  onChange(cb: (c: MachineAppsChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private removed(ids: string[]): void {
    if (ids.length === 0) return;
    for (const cb of this.listeners) cb({ kind: "removed", ids });
  }

  /** A node's whole list; `false` when it was not one (and nothing changed). */
  sync(machineId: string, raw: unknown): boolean {
    const list = parseAppList(raw);
    if (list === null) return false;
    const before = this.byMachine.get(machineId) ?? new Map<number, MachineApp>();
    const after = new Map<number, MachineApp>();
    for (const { port, name } of list) {
      const key = `${machineId}:${port}`;
      let id = this.ids.get(key);
      if (!id) {
        id = randomBytes(16).toString("hex");
        this.ids.set(key, id);
      }
      const prev = before.get(port);
      const app: MachineApp = { id, machineId, port, name, registeredAt: prev?.registeredAt ?? this.now() };
      after.set(port, app);
      this.byId.set(id, app);
    }
    const gone: string[] = [];
    for (const [port, app] of before) {
      if (after.has(port)) continue;
      this.byId.delete(app.id);
      gone.push(app.id);
    }
    if (after.size) this.byMachine.set(machineId, after);
    else this.byMachine.delete(machineId);
    this.removed(gone);
    return true;
  }

  /** The machine went offline: its apps are unreachable until it lists them again. */
  clear(machineId: string): void {
    this.sync(machineId, []);
  }

  /** Revoked or removed: everything of it, ids included. */
  forget(machineId: string): void {
    this.clear(machineId);
    for (const k of [...this.ids.keys()]) if (k.startsWith(`${machineId}:`)) this.ids.delete(k);
  }

  get(id: string): MachineApp | undefined {
    return APP_ID.test(id) ? this.byId.get(id) : undefined;
  }

  forMachine(machineId: string): MachineApp[] {
    return [...(this.byMachine.get(machineId)?.values() ?? [])].sort((a, b) => a.port - b.port);
  }
}

/**
 * Opening an app: the machines page (a POST, same-origin) gets a ticket —
 * random, single use, 60 s, bound to its machines session and the app — in
 * the URL it then opens on the machine-apps origin, where the ticket is
 * taken for a grant cookie. So the machines origin's GETs stay free of side
 * effects, and nothing the main origin serves can mint one.
 */
export const TICKET_MS = 60_000;
const MAX_TICKETS = 1_000;

export class MachineAppTickets {
  private readonly tickets = new Map<string, { session: string; appId: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(session: string, appId: string): string {
    const t = this.now();
    for (const [k, v] of this.tickets) if (v.expiresAt <= t) this.tickets.delete(k);
    while (this.tickets.size >= MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value as string);
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { session, appId, expiresAt: t + TICKET_MS });
    return ticket;
  }

  take(ticket: string, appId: string): string | null {
    const v = this.tickets.get(ticket);
    if (!v) return null;
    this.tickets.delete(ticket);
    if (v.expiresAt <= this.now() || v.appId !== appId) return null;
    return v.session;
  }
}

/**
 * A machine app's grant: `m1.<app id>.<machines session id>.<exp>.<mac>`,
 * HMAC-SHA256 under a key made at gate start (a restarted gate asks the owner
 * to open the app again from the machines page). Only as good as its session
 * still is, and scoped by its cookie's path to the one app.
 */
export { MACHINE_APP_COOKIE };
export const MACHINE_GRANT_MS = 60 * 60_000;

export class MachineAppGrants {
  private readonly key = randomBytes(32);

  private mac(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }

  mint(appId: string, session: string, expiresAt: number): string {
    const body = `m1.${appId}.${session}.${Math.floor(expiresAt / 1000).toString(36)}`;
    return `${body}.${this.mac(body)}`;
  }

  verify(value: string, now: number): { appId: string; session: string; expiresAt: number } | null {
    if (value.length > 300) return null;
    const parts = value.split(".");
    if (parts.length !== 5 || parts[0] !== "m1") return null;
    const [, appId, session, exp, mac] = parts as [string, string, string, string, string];
    if (!APP_ID.test(appId) || !/^[A-Za-z0-9_-]{1,128}$/.test(session)) return null;
    const want = Buffer.from(this.mac(`m1.${appId}.${session}.${exp}`));
    const got = Buffer.from(mac);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const expiresAt = parseInt(exp, 36) * 1000;
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
    return { appId, session, expiresAt };
  }
}

export function machineGrantCookie(appId: string, value: string, maxAgeMs: number): string {
  return `${MACHINE_APP_COOKIE}=${value}; Path=/${appId}/; Max-Age=${Math.max(1, Math.floor(maxAgeMs / 1000))}; HttpOnly; Secure; SameSite=None`;
}
