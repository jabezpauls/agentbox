import fs from "node:fs/promises";
import path from "node:path";
import type { RateReading } from "./predict.js";
import type { UsageReport } from "./report.js";
import type { ReportSource } from "./service.js";

/**
 * Codex's rate limits, from its session logs.
 *
 * Codex has no status line to hand its numbers to, but it records every
 * session as JSON lines under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,
 * and after each model response a `token_count` event carries the account's
 * rate limits as the response headers gave them. Read from openai/codex's own
 * source (codex-rs/protocol/src/protocol.rs, codex-rs/history/src/lib.rs):
 *
 *   {"timestamp":"2026-10-07T09:14:21.305Z","type":"event_msg","payload":{
 *     "type":"token_count",
 *     "info":{"last_token_usage":{"total_tokens":13669,…},"model_context_window":272000,…} | null,
 *     "rate_limits":{"limit_id":"codex","primary":{"used_percent":23.0,"window_minutes":300,"resets_at":1791378000},
 *                    "secondary":{"used_percent":41.5,"window_minutes":10080,"resets_at":1791810000},…} | null}}
 *
 * `resets_at` is epoch seconds (0.48 on); 0.41–0.47 wrote `resets_in_seconds`,
 * counted from the line's timestamp, and both are accepted. Earlier versions
 * carried no reset at all, so their readings cannot be placed in a window and
 * are skipped. `rate_limits` is null until a response has carried the
 * headers (and always for API-key sessions).
 *
 * Which window is which is the headers' say, not the protocol's: primary is
 * normally the 5-hour window and secondary the weekly one, and Codex's own UI
 * labels them by `window_minutes`. So does this: 300 is the 5-hour meter and
 * 10080 the 7-day one, whichever slot they came in. A window of any other
 * length (or none given) keeps its slot — primary as the 5-hour meter,
 * secondary as the 7-day — so the numbers still show, though the forecast,
 * which assumes the nominal lengths, will be off for it.
 *
 * The reader is cheap by construction: only the few newest day directories
 * are listed, only files written in the last day are followed, a new file is
 * read from its last TAIL_BYTES, and after that only what was appended.
 */

/** How much of a file not seen before is read: its recent history, not all of it. */
const TAIL_BYTES = 256 * 1024;
/** The most read from one file in one poll; a file that grew faster is skipped ahead. */
const MAX_READ_BYTES = 1024 * 1024;
/** Day directories looked in, newest first: today and yesterday, whatever the time zone. */
const DAY_DIRS = 3;
/** Files followed: those written within this long. */
const FOLLOW_S = 86400;

const FIVE_HOUR_MIN = 300;
const SEVEN_DAY_MIN = 10080;

interface Followed {
  offset: number;
  sessionId: string;
  model: string | null;
}

function obj(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** One window as [used, resets_at], or null when it cannot be placed. */
function windowOf(w: Record<string, unknown> | null, at: number): { used: number; resetsAt: number; minutes: number | null } | null {
  if (!w) return null;
  const used = num(w.used_percent);
  if (used === null) return null;
  const resetsAt = num(w.resets_at) ?? (num(w.resets_in_seconds) !== null ? at + (w.resets_in_seconds as number) : null);
  if (resetsAt === null) return null;
  return { used, resetsAt, minutes: num(w.window_minutes) };
}

/** Codex's `rate_limits` as the 5-hour and 7-day readings; null when there is nothing to place. */
export function codexRates(raw: unknown, at: number): RateReading | null {
  const rl = obj(raw);
  if (!rl) return null;
  // A snapshot for another limit (a separately metered model, say) is not the
  // plan's: only Codex's own, or one that does not say.
  if (typeof rl.limit_id === "string" && rl.limit_id !== "codex") return null;
  const primary = windowOf(obj(rl.primary), at);
  const secondary = windowOf(obj(rl.secondary), at);
  let five = primary;
  let seven = secondary;
  if (primary?.minutes === SEVEN_DAY_MIN || secondary?.minutes === FIVE_HOUR_MIN) {
    five = secondary;
    seven = primary;
  }
  if (!five && !seven) return null;
  return { used5h: five?.used ?? null, resets5h: five?.resetsAt ?? null, used7d: seven?.used ?? null, resets7d: seven?.resetsAt ?? null };
}

/** A `token_count` line as a report, or null for any other line. */
export function codexLineReport(line: string, f: Followed): UsageReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const rec = obj(parsed);
  const payload = obj(rec?.payload);
  if (!rec || !payload) return null;
  if (rec.type === "session_meta") {
    if (typeof payload.id === "string" && payload.id) f.sessionId = payload.id;
    return null;
  }
  if (rec.type === "turn_context") {
    if (typeof payload.model === "string" && payload.model) f.model = payload.model;
    return null;
  }
  if (rec.type !== "event_msg" || payload.type !== "token_count") return null;
  const ms = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
  if (!Number.isFinite(ms)) return null;
  const at = ms / 1000;
  const info = obj(payload.info);
  const size = num(info?.model_context_window);
  // The last request's tokens are what the context holds now. (Codex's own
  // meter also discounts a fixed baseline for its instructions; this does not.)
  const used = num(obj(info?.last_token_usage)?.total_tokens);
  return {
    provider: "codex",
    sessionId: f.sessionId,
    paneId: null,
    at,
    model: f.model,
    modelId: f.model,
    contextPct: size && used !== null ? Math.max(0, Math.min(100, (used / size) * 100)) : null,
    contextSize: size && size > 0 ? size : null,
    rates: codexRates(payload.rate_limits, at),
    // Every token_count follows a model response: the numbers are current.
    activity: rec.timestamp as string,
  };
}

async function listDesc(dir: string, pattern: RegExp): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names.filter((n) => pattern.test(n)).sort().reverse();
  } catch {
    return [];
  }
}

export class CodexSessions implements ReportSource {
  private readonly root: string;
  private readonly clock: () => number;
  private readonly followed = new Map<string, Followed>();

  constructor(opts: { home: string; clock?: () => number }) {
    this.root = path.join(opts.home, "sessions");
    this.clock = opts.clock ?? (() => Date.now() / 1000);
  }

  /** What was written since the last poll, as reports, oldest first. */
  async poll(): Promise<UsageReport[]> {
    const now = this.clock();
    const files = await this.recentFiles(now);
    for (const file of this.followed.keys()) if (!files.has(file)) this.followed.delete(file);
    const reports: UsageReport[] = [];
    for (const [file, size] of files) reports.push(...(await this.readNew(file, size)));
    return reports.sort((a, b) => a.at - b.at);
  }

  /** Rollout files in the newest day directories written in the last day, with their sizes. */
  private async recentFiles(now: number): Promise<Map<string, number>> {
    const days: string[] = [];
    outer: for (const y of await listDesc(this.root, /^\d{4}$/)) {
      for (const m of await listDesc(path.join(this.root, y), /^\d{2}$/)) {
        for (const d of await listDesc(path.join(this.root, y, m), /^\d{2}$/)) {
          days.push(path.join(this.root, y, m, d));
          if (days.length >= DAY_DIRS) break outer;
        }
      }
    }
    const out = new Map<string, number>();
    for (const day of days) {
      for (const name of await listDesc(day, /^rollout-.*\.jsonl$/)) {
        const file = path.join(day, name);
        try {
          const st = await fs.stat(file);
          if (st.isFile() && st.mtimeMs / 1000 >= now - FOLLOW_S) out.set(file, st.size);
        } catch {
          // gone since the listing
        }
      }
    }
    return out;
  }

  private async readNew(file: string, size: number): Promise<UsageReport[]> {
    let f = this.followed.get(file);
    let partialFirst = false;
    if (!f) {
      const start = Math.max(0, size - TAIL_BYTES);
      f = { offset: start, sessionId: UUID.exec(file)?.[1] ?? path.basename(file, ".jsonl"), model: null };
      partialFirst = start > 0;
      this.followed.set(file, f);
    }
    if (size < f.offset) f.offset = 0; // rewritten from the start
    if (size - f.offset > MAX_READ_BYTES) {
      f.offset = size - MAX_READ_BYTES;
      partialFirst = true;
    }
    if (size === f.offset) return [];

    let text: string;
    try {
      const fh = await fs.open(file, "r");
      try {
        const buf = Buffer.alloc(size - f.offset);
        const { bytesRead } = await fh.read(buf, 0, buf.length, f.offset);
        text = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fh.close();
      }
    } catch {
      return [];
    }
    // Only whole lines: the rest is still being written and is read next time.
    const end = text.lastIndexOf("\n");
    if (end === -1) return [];
    const whole = text.slice(0, end);
    f.offset += Buffer.byteLength(whole, "utf8") + 1;
    const lines = whole.split("\n");
    if (partialFirst) lines.shift();
    const reports: UsageReport[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const r = codexLineReport(line, f);
      if (r) reports.push(r);
    }
    return reports;
  }
}
