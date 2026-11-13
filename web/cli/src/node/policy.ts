import fs from "node:fs";
import path from "node:path";
import type { PolicySummary } from "@workbench/hostcore/link";
import { CliError } from "../errors.js";
import { writePrivate } from "./paths.js";

/**
 * `policy.json`: what the box may do on this machine. The owner's file —
 * `join` writes it once, when there is none, and nothing from the box ever
 * does. The node reads it at start and watches it.
 *
 * Missing, unparseable, or with anything in it this node does not
 * understand: everything is denied, and why is said in `status`, the log and
 * (through the link, which still connects) the browser. A missing key takes
 * its denying value.
 */

export type FileMode = "read" | "write";

export interface Policy {
  terminals: boolean;
  files: Array<{ path: string; mode: FileMode }>;
  ports: boolean;
  share: boolean;
  updates: "auto" | "notify" | "off";
  presenceHours: number;
  paused: boolean;
}

export interface LoadedPolicy {
  policy: Policy;
  /** Why everything is denied, or `null`. */
  problem: string | null;
}

export const DENY_ALL: Policy = { terminals: false, files: [], ports: false, share: false, updates: "auto", presenceHours: 12, paused: false };

const KEYS = new Set(["terminals", "files", "ports", "share", "updates", "presenceHours", "paused"]);

function broken(problem: string): LoadedPolicy {
  return { policy: { ...DENY_ALL, files: [] }, problem };
}

/** `~` and `~/…` are the home folder; every folder must then be absolute. */
function expand(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function parsePolicy(text: string, home: string): LoadedPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return broken("policy.json is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return broken("policy.json is not an object");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KEYS.has(k)) return broken(`policy.json has "${k}", which this node does not know`);
  const policy: Policy = { ...DENY_ALL, files: [] };
  for (const k of ["terminals", "ports", "share", "paused"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "boolean") return broken(`policy.json: "${k}" must be true or false`);
    policy[k] = o[k] as boolean;
  }
  if (o.updates !== undefined) {
    if (o.updates !== "auto" && o.updates !== "notify" && o.updates !== "off") return broken('policy.json: "updates" must be "auto", "notify" or "off"');
    policy.updates = o.updates;
  }
  if (o.presenceHours !== undefined) {
    const h = o.presenceHours;
    if (typeof h !== "number" || !Number.isInteger(h) || h < 1 || h > 24) return broken('policy.json: "presenceHours" must be a whole number from 1 to 24');
    policy.presenceHours = h;
  }
  if (o.files !== undefined) {
    if (!Array.isArray(o.files)) return broken('policy.json: "files" must be a list');
    for (const f of o.files as unknown[]) {
      const e = (f ?? {}) as Record<string, unknown>;
      if (typeof e.path !== "string" || e.path === "") return broken('policy.json: every "files" entry needs a "path"');
      if (e.mode !== "read" && e.mode !== "write") return broken(`policy.json: "${e.path}" needs a "mode" of "read" or "write"`);
      const full = expand(e.path, home);
      if (!path.isAbsolute(full)) return broken(`policy.json: "${e.path}" is not an absolute folder (or ~/…)`);
      policy.files.push({ path: path.normalize(full), mode: e.mode });
    }
  }
  return { policy, problem: null };
}

export function loadPolicy(file: string, home: string): LoadedPolicy {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return broken("there is no policy.json");
    return broken(`policy.json cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  return parsePolicy(text, home);
}

export function summarize(l: LoadedPolicy): PolicySummary {
  return { ...l.policy, files: l.policy.files.map((f) => ({ ...f })), problem: l.problem };
}

/**
 * Watch the file (by polling, which sees a replace-by-rename as readily as an
 * edit) and call `onChange` with what it now says, within `intervalMs` of a
 * change. Returns a function that stops watching.
 */
export function watchPolicy(file: string, home: string, onChange: (l: LoadedPolicy) => void, intervalMs = 1_000): () => void {
  let last = JSON.stringify(loadPolicy(file, home));
  const check = (): void => {
    const now = loadPolicy(file, home);
    const s = JSON.stringify(now);
    if (s === last) return;
    last = s;
    onChange(now);
  };
  fs.watchFile(file, { interval: intervalMs, persistent: false }, check);
  return () => fs.unwatchFile(file, check);
}

/** The first policy: written by `join` only when none exists. Returns whether it wrote one. */
export function writeInitialPolicy(file: string, folders: Array<{ path: string; mode: FileMode }>): boolean {
  if (fs.existsSync(file)) return false;
  const policy: Policy = { ...DENY_ALL, terminals: true, files: folders };
  writePrivate(file, `${JSON.stringify(policy, null, 2)}\n`);
  return true;
}

/** `pause` and `resume`: the one key the node itself changes, leaving the rest as the owner wrote it. */
export function setPaused(file: string, paused: boolean): void {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") o = { ...DENY_ALL };
    else throw new CliError(`${file} is not valid JSON; fix it first (everything is denied meanwhile)`);
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new CliError(`${file} is not a policy; fix it first`);
  o.paused = paused;
  writePrivate(file, `${JSON.stringify(o, null, 2)}\n`);
}
