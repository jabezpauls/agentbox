import { randomBytes } from "node:crypto";
import type { AppRecord, Store } from "./store.js";

/**
 * The app registry: every server in the sandbox that has a URL, `/a/<id>/`,
 * and who may open it. It lives in the gate's store, outside the sandbox — the
 * first rule — so the sandbox can register, change and remove apps (through
 * the sandbox-side API, always private) but never make one public: only the
 * owner's session or device token can, on the public side.
 *
 * Nothing here decides a request; `app-access.ts` does, from what this holds.
 */

/** The owner's choices when sharing. */
export type Visibility = AppRecord["visibility"]["mode"];

/** What anyone outside the gate is told about an app: never the passcode's hash, nor the epoch. */
export interface AppView {
  id: string;
  name: string;
  port: number;
  keepPrefix: boolean;
  cwd?: string;
  command?: string;
  pinned: boolean;
  createdBy: "owner" | "agent";
  createdAt: number;
  visibility: { mode: Visibility; expiresAt: number | null; sharedAt?: number };
  compat: "auto" | "off";
}

/** What may be set when an app is registered or changed. Visibility is not among it. */
export interface AppInput {
  name?: unknown;
  port?: unknown;
  cwd?: unknown;
  command?: unknown;
  pinned?: unknown;
  keepPrefix?: unknown;
  compat?: unknown;
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A registry this size is a script gone wrong, not a person's apps. */
export const MAX_APPS = 200;
const MAX_NAME = 64;
const MAX_TEXT = 4096;
/** Longest a link may be set to last, when it has an end at all. */
export const MAX_EXPIRY_MS = 366 * 24 * 60 * 60_000;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 26 characters of lowercase base32: 128 random bits (the last character carries three). */
export function newAppId(): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export const APP_ID_SHAPE = /^[a-z2-7]{26}$/;

/** The shortest passcode the owner may set. */
export const MIN_PASSCODE = 8;

/**
 * A passcode made for the owner: three groups of four from an alphabet
 * without look-alikes (`k7mq-2xnd-p9wt`), about 60 bits — easy to read out,
 * and far beyond what the passcode page's limits let anyone guess.
 */
export function generatePasscode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) out += "-";
    out += alphabet[(bytes[i] as number) % alphabet.length];
  }
  return out;
}

export function isAppId(id: string): boolean {
  return APP_ID_SHAPE.test(id);
}

export function toView(app: AppRecord): AppView {
  const v = app.visibility;
  return {
    id: app.id,
    name: app.name,
    port: app.port,
    keepPrefix: app.keepPrefix,
    ...(app.cwd !== undefined ? { cwd: app.cwd } : {}),
    ...(app.command !== undefined ? { command: app.command } : {}),
    pinned: app.pinned,
    createdBy: app.createdBy,
    createdAt: app.createdAt,
    visibility: { mode: v.mode, expiresAt: v.expiresAt, ...(v.sharedAt !== undefined ? { sharedAt: v.sharedAt } : {}) },
    compat: app.compat,
  };
}

/** Printable text without control characters, trimmed; `null` when it is not that. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "" || t.length > max || /[\u0000-\u001f\u007f]/.test(t)) return null;
  return t;
}

/** Why an app changed, for whoever holds its connections. */
export type AppChange =
  /** Nothing about who may open it changed (a rename, say). */
  | { kind: "edited"; id: string }
  /** Anyone let in as the public, or by a passcode, is out. */
  | { kind: "unshared"; id: string; public: boolean; passcode: boolean }
  /** The app is gone: everyone is out. */
  | { kind: "removed"; id: string };

export class AppRegistry {
  private revisionNo = 0;
  private readonly listeners = new Set<(change: AppChange) => void>();
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly store: Store,
    private readonly opts: { infraPorts: number[]; sharing: boolean; now?: () => number },
  ) {
    for (const app of store.apps) normalise(app);
    // Sharing turned off (the installer's --sharing off) makes every app
    // private again, for good, rather than leaving links that open when it
    // comes back.
    if (!opts.sharing) {
      const shared = store.apps.filter((app) => app.visibility.mode !== "private");
      for (const app of shared) this.makePrivate(app);
      if (shared.length > 0) {
        store.save().catch((err: unknown) => console.error("[gate] could not save apps made private", err));
      }
    }
  }

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Bumped on every change, so the bridge can wait for the next one. */
  get revision(): number {
    return this.revisionNo;
  }

  get sharing(): boolean {
    return this.opts.sharing;
  }

  isInfraPort(port: number): boolean {
    return this.opts.infraPorts.includes(port);
  }

  /** Hear about every change that may affect who is connected to an app. */
  onChange(listener: (change: AppChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolve after the next change, or after `ms`, whichever comes first. */
  waitForChange(since: number, ms: number): Promise<void> {
    if (this.revisionNo !== since) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.waiters.add(done);
    });
  }

  private changed(change: AppChange): void {
    this.revisionNo += 1;
    for (const l of this.listeners) l(change);
    for (const w of [...this.waiters]) w();
  }

  list(): AppRecord[] {
    return this.store.apps;
  }

  get(id: string): AppRecord | undefined {
    if (!isAppId(id)) return undefined;
    return this.store.apps.find((a) => a.id === id);
  }

  /**
   * Whether the public may open it now: shared, unexpired, and sharing on.
   * Expiry is judged here, at the moment of asking, not only by the sweep.
   */
  isPublic(app: AppRecord): "link" | "passcode" | null {
    if (!this.opts.sharing) return null;
    const v = app.visibility;
    if (v.mode === "private") return null;
    if (v.expiresAt !== null && v.expiresAt <= this.now) return null;
    return v.mode;
  }

  private port(v: unknown): number {
    const port = Number(v);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new AppError(400, "invalid_port", "port must be a whole number from 1 to 65535");
    }
    if (this.isInfraPort(port)) {
      throw new AppError(400, "infrastructure_port", `port ${port} belongs to agentbox itself and cannot be an app`);
    }
    return port;
  }

  /** Apply the settable fields in `input` to `app`, checking each. */
  private apply(app: AppRecord, input: AppInput): void {
    if (input.port !== undefined) app.port = this.port(input.port);
    if (input.name !== undefined) {
      const name = text(input.name, MAX_NAME);
      if (name === null) throw new AppError(400, "invalid_name", `name must be 1 to ${MAX_NAME} printable characters`);
      app.name = name;
    }
    for (const key of ["cwd", "command"] as const) {
      const v = input[key];
      if (v === undefined) continue;
      if (v === null || v === "") {
        delete app[key];
        continue;
      }
      const t = text(v, MAX_TEXT);
      if (t === null) throw new AppError(400, `invalid_${key}`, `${key} must be printable text`);
      if (key === "cwd" && !t.startsWith("/")) throw new AppError(400, "invalid_cwd", "cwd must be an absolute path");
      app[key] = t;
    }
    for (const key of ["pinned", "keepPrefix"] as const) {
      const v = input[key];
      if (v === undefined) continue;
      if (typeof v !== "boolean") throw new AppError(400, `invalid_${key}`, `${key} must be true or false`);
      app[key] = v;
    }
    if (input.compat !== undefined) {
      if (input.compat !== "auto" && input.compat !== "off") throw new AppError(400, "invalid_compat", "compat must be auto or off");
      app.compat = input.compat;
    }
  }

  /** Register an app. Always private, whoever asks. */
  async create(input: AppInput, createdBy: "owner" | "agent"): Promise<AppRecord> {
    if (this.store.apps.length >= MAX_APPS) throw new AppError(409, "too_many", `at most ${MAX_APPS} apps; remove one first`);
    if (input.port === undefined) throw new AppError(400, "invalid_port", "port is required");
    const app: AppRecord = {
      id: newAppId(),
      name: "",
      port: this.port(input.port),
      keepPrefix: false,
      pinned: false,
      createdBy,
      createdAt: this.now,
      visibility: { mode: "private", expiresAt: null, epoch: 0 },
      compat: "auto",
    };
    this.apply(app, input);
    if (app.name === "") app.name = defaultName(app);
    this.store.apps.push(app);
    await this.store.save();
    this.changed({ kind: "edited", id: app.id });
    return app;
  }

  /** Change an app's settings. Visibility is not among them. */
  async update(id: string, input: AppInput): Promise<AppRecord> {
    const app = this.get(id);
    if (!app) throw new AppError(404, "not_found", "no such app");
    const draft = structuredClone(app);
    this.apply(draft, input);
    Object.assign(app, draft);
    for (const key of ["cwd", "command"] as const) if (!(key in draft)) delete app[key];
    await this.store.save();
    this.changed({ kind: "edited", id });
    return app;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.store.apps.length;
    this.store.data.apps = this.store.apps.filter((a) => a.id !== id);
    if (this.store.apps.length === before) return false;
    await this.store.save();
    this.changed({ kind: "removed", id });
    return true;
  }

  /**
   * The owner's decision: private, anyone with the link, or anyone with the
   * link and a passcode — until `expiresAt`, or until stopped. Whatever it
   * takes away is taken away at once: a link made private cuts off everyone
   * let in as the public, and a new passcode (or none) voids every grant the
   * old one gave.
   */
  async setVisibility(
    id: string,
    next: { mode: Visibility; expiresAt: number | null; passcodeHash?: string },
  ): Promise<AppRecord> {
    const app = this.get(id);
    if (!app) throw new AppError(404, "not_found", "no such app");
    if (next.mode !== "private" && !this.opts.sharing) {
      throw new AppError(403, "sharing_off", "sharing is turned off on this box (install.sh --sharing on turns it back on)");
    }
    if (next.mode === "private") {
      this.makePrivate(app);
      await this.store.save();
      return app;
    }
    const v = app.visibility;
    const wasPublic = v.mode === "link";
    const wasPasscode = v.mode === "passcode";
    const passcodeHash = next.mode === "passcode" ? (next.passcodeHash ?? v.passcodeHash) : undefined;
    if (next.mode === "passcode" && !passcodeHash) {
      throw new AppError(400, "passcode_required", "a passcode is required");
    }
    const passcodeChanged = wasPasscode && (next.mode !== "passcode" || next.passcodeHash !== undefined);
    app.visibility = {
      mode: next.mode,
      expiresAt: next.expiresAt,
      ...(passcodeHash ? { passcodeHash } : {}),
      sharedAt: v.mode === "private" ? this.now : (v.sharedAt ?? this.now),
      epoch: passcodeChanged ? v.epoch + 1 : v.epoch,
    };
    await this.store.save();
    const cutPublic = wasPublic && next.mode !== "link";
    if (cutPublic || passcodeChanged) this.changed({ kind: "unshared", id, public: cutPublic, passcode: passcodeChanged });
    else this.changed({ kind: "edited", id });
    return app;
  }

  /** Make `app` private and announce it; the caller saves. */
  private makePrivate(app: AppRecord): void {
    const v = app.visibility;
    const was = v.mode;
    app.visibility = { mode: "private", expiresAt: null, epoch: v.epoch + (was === "private" ? 0 : 1) };
    if (was === "private") this.changed({ kind: "edited", id: app.id });
    else this.changed({ kind: "unshared", id: app.id, public: true, passcode: true });
  }

  /** Make every app whose link has run out private. Returns how many. */
  async expire(): Promise<number> {
    const t = this.now;
    let n = 0;
    for (const app of this.store.apps) {
      const v = app.visibility;
      if (v.mode !== "private" && v.expiresAt !== null && v.expiresAt <= t) {
        this.makePrivate(app);
        n += 1;
      }
    }
    if (n > 0) await this.store.save();
    return n;
  }
}

/** A record written by an older gate, or edited by hand, brought into shape. */
function normalise(app: AppRecord): void {
  app.visibility ??= { mode: "private", expiresAt: null, epoch: 0 };
  if (typeof app.visibility.epoch !== "number") app.visibility.epoch = 0;
  app.compat = app.compat === "off" ? "off" : "auto";
  app.pinned = app.pinned === true;
  app.keepPrefix = app.keepPrefix === true;
}

/** A name for an app registered without one: its folder, or its port. */
function defaultName(app: AppRecord): string {
  const base = app.cwd?.split("/").filter(Boolean).pop();
  return (base && text(base, MAX_NAME)) || `port ${app.port}`;
}
