/**
 * Rate-limit reconciliation and end-of-window projection: a TypeScript port of
 * claude-statusbar's `predict.py` (3.21.1).
 *
 *   claude-statusbar — https://github.com/leeguooooo/claude-code-usage-bar
 *   Copyright (c) 2024 leeguooooo
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the
 *   "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit
 *   persons to whom the Software is furnished to do so, subject to the
 *   following conditions:
 *
 *   The above copyright notice and this permission notice shall be included
 *   in all copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 *   OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 *   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
 *   NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 *   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 *   USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * The algorithms are the original's, constant for constant; the comments that
 * explain them are carried over, trimmed. What changed is the plumbing. The
 * original keeps two JSON files that every Claude Code window's status line
 * reads and rewrites about once a second, so it guards against concurrent
 * writers and re-reads its stores on every render. Here the bridge receives
 * every session's report and is the only writer, so the stores are plain
 * objects: each function takes the state it works on (and mutates it, where
 * the original rewrote its file), the reading, and `now` — no I/O and no clock.
 * The service (service.ts) owns the state, keys it by account and persists it.
 *
 * Projects each window's end-of-window usage from the AVERAGE pace so far this
 * window rather than a noisy recent burst, blended with recent and
 * time-of-day rates the store learns as it goes. `resets_at` marks the reset;
 * the window has been accumulating since `resets_at - WINDOW_LEN_S`, so:
 *
 *     elapsed   = window_len - time_to_reset
 *     avg_rate  = used_pct / elapsed                  # %/s over the window so far
 *     projected = used_pct + avg_rate * time_to_reset
 *     ttl       = (100 - used_pct) / avg_rate         # secs to 100% at that pace
 *
 * Times are epoch seconds throughout, as Claude Code reports them.
 */

export type WindowKey = "five_hour" | "seven_day";
export const WINDOWS: readonly WindowKey[] = ["five_hour", "seven_day"];

/**
 * Fixed nominal window lengths. The 5h and 7d limits are plan-level constants;
 * resets_at gives the reset instant, so the window started one length before.
 */
export const WINDOW_LEN_S: Record<WindowKey, number> = { five_hour: 5 * 3600, seven_day: 7 * 86400 };
/**
 * Don't forecast until the window is at least this far along — very early on,
 * a couple of percent over a few minutes projects wildly.
 */
export const MIN_ELAPSED_S: Record<WindowKey, number> = { five_hour: 10 * 60, seven_day: 60 * 60 };
/** A countdown only helps when the wall is genuinely near; beyond this it is noise. */
export const IMMINENT_ETA_S = 60 * 60;

export const MAX_PROJECTION_SAMPLES = 5000;
export const MAX_PROJECTION_SNAPSHOTS = 1000;
export const MAX_CLOSED_WINDOWS = 100;

/**
 * Per-window plausibility cap for observed burn rates (%/h). 5h usage can
 * legitimately spike to a full window in well under an hour (54%→62% in 13
 * minutes was seen live); 7d usage physically can't move that fast.
 */
export const RATE_CAP_PCT_PER_H: Record<WindowKey, number> = { five_hour: 60.0, seven_day: 10.0 };
/**
 * Minimum observation span for a "recent rate": used_pct moves in integer
 * steps, so two readings seconds apart say nothing about pace.
 */
export const MIN_RECENT_RATE_SPAN_S = 300.0;
/** How far the measured recent rate carries the 7d projection forward (also its lookback). */
export const RECENT_MOMENTUM_HORIZON_S = 3 * 3600.0;

export type TimeBucket = "night" | "weekday_work_hours" | "weekday_non_work_hours" | "weekend";
export const DEFAULT_BUCKET_PRIORS: Record<TimeBucket, number> = {
  night: 0.02,
  weekday_work_hours: 0.45,
  weekday_non_work_hours: 0.12,
  weekend: 0.1,
};
export const LEARNED_BUCKET_FULL_WEIGHT_SAMPLES = 20;
export const TAU_SECONDS: Record<WindowKey, number> = { five_hour: 8 * 60, seven_day: 2 * 3600 };

/**
 * How many per-reset buckets a window slot may hold: a backstop against clock
 * weirdness; plausibility already caps a bucket's life.
 */
export const MAX_RESET_BUCKETS = 8;
/**
 * How long a stored reading may go unconfirmed before a lower same-reset
 * reading is accepted as an official re-baseline (limits raised: same
 * resets_at, lower pct — seen live as seven_day 19% → 3%). Any session still
 * seeing the higher value re-confirms it, so this much silence means no live
 * session believes the old number any more.
 */
export const DOWNGRADE_GRACE_S = 120.0;
/** Throttle for confirmation-only updates (the same value re-observed). */
export const CONFIRM_REFRESH_S = 15.0;
/**
 * A session whose rate-limits signature (u5, r5, u7, r7) hasn't changed for
 * this long is replaying a frozen blob: Claude Code only refreshes rate_limits
 * on API activity, so an idle-but-open session re-reports the same numbers
 * forever. Frozen sessions lose write and confirm rights, but still display.
 */
export const RL_IDLE_TTL_S = 600.0;
/** Per-session signature entries: drop those idle past the horizon, cap the map. */
export const SESSION_SIG_HORIZON_S = 2 * 86400.0;
export const MAX_SESSION_SIGS = 64;
/**
 * Burn-rate regime detection: a model switch, or a session joining with a
 * model the active fleet doesn't run, steps the burn rate, and a trailing
 * window spanning the step averages it away. Rate estimation clips its
 * lookback to the last boundary, and right after one the minimum span relaxes
 * to this so the projection jumps onto the new rate within minutes.
 */
export const REGIME_MIN_SPAN_S = 120.0;
/** A session whose signature changed within this horizon is part of the active fleet. */
export const FLEET_ACTIVE_S = 900.0;

// ---------------------------------------------------------------------------
// The account store: the freshest reading per window, shared by all sessions.

export interface Bucket {
  used: number;
  /** When a live session last reported (or re-confirmed) this value; absent = unconfirmed. */
  observed_at?: number;
}
export interface SessionSig {
  sig: (number | null)[];
  changed_at: number;
  model?: string;
}
export interface Regime {
  changed_at: number;
  reason: "model-switch" | "fleet-join";
  model: string;
}
/** One account's latest readings: per window, per-reset buckets keyed by `String(trunc(resets_at))`. */
export interface AccountStore {
  five_hour: Record<string, Bucket>;
  seven_day: Record<string, Bucket>;
  sessions: Record<string, SessionSig>;
  regime?: Regime;
}

export function emptyAccountStore(): AccountStore {
  return { five_hour: {}, seven_day: {}, sessions: {} };
}

/** One session's report of an account's windows. Any field may be missing. */
export interface RateReading {
  used5h: number | null;
  resets5h: number | null;
  used7d: number | null;
  resets7d: number | null;
}

export interface Reconciled extends RateReading {
  /**
   * The reading was taken as live: its blob is current (no implausible reset,
   * not a frozen replay) and at least one window was usable. Not in the
   * original, which had no use for it; the service uses it for `stale`.
   */
  live: boolean;
}

function num(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A real reset is within [now-60s, now + window_len + 1 day]. Rejecting
 * anything else stops a bogus far-future resets_at from permanently poisoning
 * the monotonic merge (a later reset always "wins").
 */
export function resetPlausible(window: WindowKey, reset: number | null, now: number): boolean {
  if (reset === null) return false;
  const length = WINDOW_LEN_S[window];
  return now - 60.0 <= reset && reset <= now + length + 86400.0;
}

function sameSig(a: (number | null)[] | undefined, b: (number | null)[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Merge one session's reading into the account store and return the freshest
 * (u5, r5, u7, r7) for that session's windows.
 *
 * `record: false` answers from the store without writing or counting as a
 * confirmation — for callers fed already-reconciled values, whose echoes
 * would otherwise restart the grace clock forever.
 *
 * `sessionId` enables the frozen-blob gate (RL_IDLE_TTL_S). A reading's
 * identity is (window, resets_at): readings for different resets coexist in
 * per-reset buckets and each is answered from the bucket matching its own
 * reset. Within one bucket: monotonic up, equal readings refresh the grace
 * clock, lower readings accepted as an official re-baseline once unconfirmed
 * for DOWNGRADE_GRACE_S. Never throws — on any error returns the inputs.
 */
export function reconcileAccount(
  store: AccountStore,
  reading: RateReading,
  now: number,
  opts: { sessionId?: string | null; model?: string | null; record?: boolean } = {},
): Reconciled {
  const record = opts.record ?? true;
  const { sessionId, model } = opts;
  try {
    const out: Partial<Record<WindowKey, [number | null, number | null]>> = {};
    let anyUsable = false;
    // Both windows come from the same API response headers, so one
    // implausible resets_at dates the WHOLE blob: a five_hour reset in the
    // past means the headers are hours old. Such blobs must neither write the
    // store nor count as confirmations.
    let blobFresh = true;
    const pairs: [WindowKey, number | null, number | null][] = [
      ["five_hour", num(reading.used5h), num(reading.resets5h)],
      ["seven_day", num(reading.used7d), num(reading.resets7d)],
    ];
    for (const [win, , r] of pairs) {
      if (r !== null && !resetPlausible(win, r, now)) blobFresh = false;
    }

    // Frozen-blob gate: reset plausibility can't date a blob frozen inside the
    // current 5h window, but an unchanged per-session signature can.
    if (record && sessionId) {
      let sessions = store.sessions && typeof store.sessions === "object" ? store.sessions : {};
      const sig = [pairs[0]![1], pairs[0]![2], pairs[1]![1], pairs[1]![2]];
      const ent = sessions[sessionId];
      const prevSig = ent?.sig;
      const seenAt = ent ? num(ent.changed_at) : null;
      const prevModel = ent?.model;

      // Burn-rate regime boundary: this session switched models, or a new
      // session joined bringing a model the active fleet doesn't run.
      let bump: Regime["reason"] | null = null;
      if (model) {
        if (prevModel && model !== prevModel) {
          bump = "model-switch";
        } else if (ent === undefined) {
          const activeCut = now - FLEET_ACTIVE_S;
          const fleet = new Set(
            Object.values(sessions)
              .filter((v) => v && v.model && (num(v.changed_at) ?? 0) >= activeCut)
              .map((v) => v.model as string),
          );
          if (fleet.size > 0 && !fleet.has(model)) bump = "fleet-join";
        }
      }
      if (bump) store.regime = { changed_at: now, reason: bump, model: model as string };

      const keepModel = model || prevModel;
      if (sameSig(prevSig, sig) && seenAt !== null) {
        if (now - seenAt > RL_IDLE_TTL_S) blobFresh = false;
        if (keepModel && prevModel !== keepModel && ent) {
          sessions[sessionId] = { ...ent, model: keepModel };
        }
      } else {
        sessions[sessionId] = keepModel ? { sig, changed_at: now, model: keepModel } : { sig, changed_at: now };
      }
      const cutoff = now - SESSION_SIG_HORIZON_S;
      let kept = Object.entries(sessions).filter(([, v]) => v && (num(v.changed_at) ?? 0) >= cutoff);
      if (kept.length > MAX_SESSION_SIGS) {
        kept = kept
          .sort((a, b) => (num(b[1].changed_at) ?? 0) - (num(a[1].changed_at) ?? 0))
          .slice(0, MAX_SESSION_SIGS);
      }
      if (kept.length !== Object.keys(sessions).length) sessions = Object.fromEntries(kept);
      store.sessions = sessions;
    }

    for (const [win, cu, cr] of pairs) {
      // GC buckets whose window expired or whose reset is implausible
      // (poisoned far-future values die here too).
      let entries = Object.entries(store[win] ?? {}).filter(
        ([k, v]) => v && num(v.used) !== null && resetPlausible(win, num(k), now),
      );
      if (entries.length > MAX_RESET_BUCKETS) {
        entries = entries
          .sort((a, b) => (num(b[1].observed_at) ?? 0) - (num(a[1].observed_at) ?? 0))
          .slice(0, MAX_RESET_BUCKETS);
      }
      const buckets: Record<string, Bucket> = Object.fromEntries(entries);

      const crOk = cr !== null && resetPlausible(win, cr, now);
      const curOk = cu !== null && blobFresh && crOk;
      if (curOk) anyUsable = true;
      const key = crOk ? String(Math.trunc(cr as number)) : null;
      const ent = key !== null ? buckets[key] : undefined;
      const pu = ent ? num(ent.used) : null;
      const po = ent ? num(ent.observed_at) : null;
      // Unconfirmed: nothing has re-observed the bucket within the grace period.
      const unconfirmed = po === null || now - po > DOWNGRADE_GRACE_S;

      if (curOk && (pu === null || (cu as number) > pu || ((cu as number) < pu && unconfirmed))) {
        // First sighting, monotonic growth, or an official downward
        // re-baseline that went unchallenged for the whole grace period.
        if (record) buckets[key as string] = { used: cu as number, observed_at: now };
        out[win] = [cu, cr];
      } else if (curOk && cu === pu) {
        if (record && (po === null || now - po > CONFIRM_REFRESH_S)) {
          // Same reading re-observed: restart the grace clock so a value a
          // live session still agrees with can't be downgraded by a replay.
          buckets[key as string] = { used: pu, observed_at: now };
        }
        out[win] = [pu, cr];
      } else if (curOk) {
        // cu < pu within grace — a stale same-window replay loses.
        out[win] = [pu, cr];
      } else if (pu !== null) {
        // Stale blob, but its window is in the store: display the shared reading.
        out[win] = [pu, cr];
      } else if (crOk) {
        // Plausible window with nothing stored, but a stale blob: pass through
        // for display, never persist as confirmed.
        out[win] = [cu, cr];
      } else if (Object.keys(buckets).length > 0) {
        // No usable own reading: fall back to the freshest stored bucket.
        const bk = Object.keys(buckets).reduce((best, k) =>
          (num(buckets[k]!.observed_at) ?? 0) > (num(buckets[best]!.observed_at) ?? 0) ? k : best,
        );
        out[win] = [num(buckets[bk]!.used), num(bk)];
      } else {
        out[win] = [cu, cr];
      }
      if (record) store[win] = buckets;
    }
    return {
      used5h: out.five_hour![0],
      resets5h: out.five_hour![1],
      used7d: out.seven_day![0],
      resets7d: out.seven_day![1],
      live: blobFresh && anyUsable,
    };
  } catch {
    return { ...reading, live: false };
  }
}

// ---------------------------------------------------------------------------
// The near-cap ETA.

/**
 * (projected_final_pct, seconds_to_100) at the window's average pace so far,
 * or null when it can't be computed: bad input, before the window started, no
 * usage, or already capped.
 */
export function projectWindow(used: number, timeToReset: number, windowLen: number): [number, number] | null {
  if (![used, timeToReset, windowLen].every(Number.isFinite)) return null;
  if (timeToReset <= 0 || windowLen <= 0 || used <= 0 || used >= 100) return null;
  const elapsed = windowLen - timeToReset;
  if (elapsed <= 0) return null;
  const avgRate = used / elapsed;
  return [used + avgRate * timeToReset, (100.0 - used) / avgRate];
}

/**
 * Seconds to the cap, only when the window is projected (at its average pace)
 * to hit 100% within IMMINENT_ETA_S before it resets; otherwise null. The
 * original's `forecast_chip`, returning the number it formatted.
 */
export function forecastEta(window: WindowKey, used: number | null, resetsAt: number | null, now: number): number | null {
  if (used === null || resetsAt === null) return null;
  const timeToReset = resetsAt - now;
  const length = WINDOW_LEN_S[window];
  if (timeToReset <= 0) return null;
  if (length - timeToReset < MIN_ELAPSED_S[window]) return null; // too early to trust
  const projected = projectWindow(used, timeToReset, length);
  if (projected === null) return null;
  const [final, ttl] = projected;
  if (final >= 100 && ttl <= IMMINENT_ETA_S) return Math.floor(ttl);
  return null;
}

// ---------------------------------------------------------------------------
// The projection store: sampled history, learned rates and display smoothing.

export interface Sample {
  observed_at: number;
  used_pct: number;
  resets_at: number;
  session_id?: string;
}
export interface DisplayState {
  projected_pct: number;
  updated_at: number;
  resets_at?: number;
}
export interface ProjectionSnapshot {
  window: WindowKey;
  observed_at: number;
  used_pct: number;
  resets_at: number;
  model: "projection_v1";
  projected_pct: number;
}
export interface ClosedWindow {
  window: WindowKey;
  previous_resets_at: number;
  actual_final_pct: number;
  closed_at: number;
}
export interface ProjectionStore {
  version: 1;
  five_hour: Sample[];
  seven_day: Sample[];
  display: Partial<Record<WindowKey, DisplayState>>;
  snapshots: ProjectionSnapshot[];
  closed_windows: ClosedWindow[];
}

export function emptyProjectionStore(): ProjectionStore {
  return { version: 1, five_hour: [], seven_day: [], display: {}, snapshots: [], closed_windows: [] };
}

/** A store read back from disk, made whole and bounded (the original's `load_projection_store`). */
export function normalizeProjectionStore(data: unknown): ProjectionStore {
  const store = emptyProjectionStore();
  if (!data || typeof data !== "object") return store;
  const d = data as Record<string, unknown>;
  for (const w of WINDOWS) {
    if (Array.isArray(d[w])) store[w] = compressedSamples(d[w] as Sample[], w).slice(-MAX_PROJECTION_SAMPLES);
  }
  if (d.display && typeof d.display === "object" && !Array.isArray(d.display)) {
    store.display = d.display as ProjectionStore["display"];
  }
  if (Array.isArray(d.snapshots)) store.snapshots = (d.snapshots as ProjectionSnapshot[]).slice(-MAX_PROJECTION_SNAPSHOTS);
  if (Array.isArray(d.closed_windows)) store.closed_windows = (d.closed_windows as ClosedWindow[]).slice(-MAX_CLOSED_WINDOWS);
  return store;
}

function sampleNumbers(sample: unknown): [number, number, number] | null {
  if (!sample || typeof sample !== "object") return null;
  const s = sample as Record<string, unknown>;
  const ts = num(s.observed_at);
  const used = num(s.used_pct);
  const reset = num(s.resets_at);
  if (ts === null || used === null || reset === null) return null;
  if (ts <= 0 || reset <= 0 || used < 0) return null;
  return [ts, Math.max(0, Math.min(100, used)), reset];
}

/** Claude can refresh slightly late; anything much farther than the nominal window is polluted history. */
function plausibleSampleReset(window: WindowKey, observedAt: number, resetsAt: number): boolean {
  const length = WINDOW_LEN_S[window];
  return resetsAt >= observedAt - 60.0 && resetsAt <= observedAt + length + 86400.0;
}

/** Per reset, only the samples where usage grew; ordered by time. */
export function compressedSamples(samples: readonly unknown[], window?: WindowKey): Sample[] {
  const grouped = new Map<number, [number, number, number][]>();
  for (const sample of samples) {
    const vals = sampleNumbers(sample);
    if (vals === null) continue;
    const [ts, , reset] = vals;
    if (window !== undefined && !plausibleSampleReset(window, ts, reset)) continue;
    const rows = grouped.get(reset) ?? [];
    rows.push(vals);
    grouped.set(reset, rows);
  }
  const out: Sample[] = [];
  for (const [reset, rows] of grouped) {
    let lastUsed: number | null = null;
    for (const [ts, used] of [...rows].sort((a, b) => a[0] - b[0])) {
      if (lastUsed !== null && used <= lastUsed) continue;
      out.push({ observed_at: ts, used_pct: used, resets_at: reset });
      lastUsed = used;
    }
  }
  out.sort((a, b) => a.observed_at - b.observed_at);
  return out;
}

export function recordProjectionSample(
  store: ProjectionStore,
  window: WindowKey,
  used: number,
  resetsAt: number,
  observedAt: number,
  sessionId = "",
): ProjectionStore {
  if (![used, resetsAt, observedAt].every(Number.isFinite)) return store;
  if (observedAt <= 0 || resetsAt <= 0 || used < 0) return store;
  if (!plausibleSampleReset(window, observedAt, resetsAt)) return store;
  const sample: Sample = {
    observed_at: observedAt,
    used_pct: Math.max(0, Math.min(100, used)),
    resets_at: resetsAt,
    session_id: sessionId,
  };
  let series = Array.isArray(store[window]) ? store[window] : (store[window] = []);
  // Windows with different resets coexist, so a sample is only compared with
  // samples of its own reset.
  const sameReset = compressedSamples(series, window).filter((s) => s.resets_at === resetsAt);
  if (sameReset.length > 0) {
    const maxUsed = Math.max(...sameReset.map((s) => s.used_pct));
    if (sample.used_pct === maxUsed) return store;
    if (sample.used_pct < maxUsed) {
      // Inputs arrive reconciled, so a reading below the same-reset max means
      // the limit was re-baselined mid-window. Every stored sample for THIS
      // reset is in old-denominator units — incomparable — so drop them and
      // restart this window's display smoothing. Other resets' samples stay.
      series = series.filter((s) => num(s.resets_at) !== resetsAt);
      store[window] = series;
      const disp = store.display[window];
      if (disp && (disp.resets_at === undefined || disp.resets_at === resetsAt)) delete store.display[window];
    }
  }
  const last = series[series.length - 1];
  if (
    last &&
    last.observed_at === sample.observed_at &&
    last.used_pct === sample.used_pct &&
    last.resets_at === sample.resets_at &&
    (last.session_id ?? "") === sample.session_id
  ) {
    return store;
  }
  series.push(sample);
  series.sort((a, b) => (num(a.observed_at) ?? 0) - (num(b.observed_at) ?? 0));
  if (series.length > MAX_PROJECTION_SAMPLES) series.splice(0, series.length - MAX_PROJECTION_SAMPLES);
  return store;
}

/** Local time of day, as the box's TZ has it: work hours, evenings, nights, weekends. */
export function bucketForTime(ts: number): TimeBucket {
  const d = new Date(ts * 1000);
  const hour = d.getHours();
  if (hour < 7) return "night";
  const day = d.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return "weekend";
  if (hour >= 9 && hour < 18) return "weekday_work_hours";
  return "weekday_non_work_hours";
}

export interface LearnedRate {
  total_rate: number;
  samples: number;
  rate_per_hour: number;
}

export function learnBucketRates(samples: readonly Sample[], window?: WindowKey): Partial<Record<TimeBucket, LearnedRate>> {
  const cap = window ? RATE_CAP_PCT_PER_H[window] : 20.0;
  const out: Partial<Record<TimeBucket, LearnedRate>> = {};
  const ordered = compressedSamples(samples);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    if (cur.resets_at !== prev.resets_at) continue;
    const dt = cur.observed_at - prev.observed_at;
    const du = cur.used_pct - prev.used_pct;
    if (dt < 300 || du <= 0) continue;
    const ratePerHour = du / (dt / 3600.0);
    if (ratePerHour > cap) continue;
    const bucket = bucketForTime(prev.observed_at);
    const agg = (out[bucket] ??= { total_rate: 0, samples: 0, rate_per_hour: 0 });
    agg.total_rate += ratePerHour;
    agg.samples += 1;
  }
  for (const [bucket, agg] of Object.entries(out) as [TimeBucket, LearnedRate][]) {
    agg.rate_per_hour = agg.samples ? agg.total_rate / agg.samples : DEFAULT_BUCKET_PRIORS[bucket];
  }
  return out;
}

/** A bucket's rate (%/h): its prior, blended toward what was learned as samples accrue. */
export function expectedBucketRate(bucket: TimeBucket, learned?: LearnedRate): number {
  const prior = DEFAULT_BUCKET_PRIORS[bucket] ?? 0;
  if (!learned) return prior;
  const learnedRate = num(learned.rate_per_hour) ?? prior;
  const n = Math.max(0, num(learned.samples) ?? 0);
  const weight = Math.min(1.0, n / LEARNED_BUCKET_FULL_WEIGHT_SAMPLES);
  return prior * (1.0 - weight) + learnedRate * weight;
}

/** Usage (%) expected between two instants, hour by hour, at each hour's bucket rate. */
export function integrateFutureBuckets(startTs: number, endTs: number, learned: Partial<Record<TimeBucket, LearnedRate>>): number {
  if (endTs <= startTs) return 0;
  let total = 0;
  let cursor = startTs;
  while (cursor < endTs) {
    const stepEnd = Math.min(endTs, cursor + 3600.0);
    const bucket = bucketForTime(cursor);
    total += expectedBucketRate(bucket, learned[bucket]) * ((stepEnd - cursor) / 3600.0);
    cursor = stepEnd;
  }
  return total;
}

function samplesForReset(samples: readonly Sample[], resetsAt: number): Sample[] {
  return samples.filter((s) => num(s.resets_at) === resetsAt);
}

/**
 * The burn rate (%/s) over the last `lookbackS`, from the first to the last
 * sample in it; null when the span is too short, usage didn't grow, or the
 * rate is implausible. A regime boundary inside the lookback clips it and
 * relaxes the minimum span.
 */
export function rateFromSamples(
  samples: readonly Sample[],
  now: number,
  lookbackS: number,
  window?: WindowKey,
  since?: number | null,
): number | null {
  const cap = window ? RATE_CAP_PCT_PER_H[window] : 20.0;
  let cutoff = now - lookbackS;
  let spanMin = MIN_RECENT_RATE_SPAN_S;
  if (since !== undefined && since !== null && since > cutoff) {
    cutoff = since;
    spanMin = REGIME_MIN_SPAN_S;
  }
  const inWindow = compressedSamples(samples).filter((s) => s.observed_at >= cutoff && s.observed_at <= now);
  if (inWindow.length < 2) return null;
  const first = inWindow[0]!;
  const last = inWindow[inWindow.length - 1]!;
  const dt = last.observed_at - first.observed_at;
  const du = last.used_pct - first.used_pct;
  if (dt < spanMin || du <= 0) return null;
  const rate = du / dt;
  if (rate > cap / 3600.0) return null;
  return rate;
}

/**
 * Where the 5-hour window ends: a blend of the recent rate (the faster of the
 * last hour and the last 30 minutes) at 0.55, the window's average pace at
 * 0.30 and the time-of-day bucket at 0.15; without a recent rate, 0.75 / 0.25.
 * Taking the faster recent rate tracks ramps (more sessions, a hungrier
 * model): backtested, it cut heavy-window misses at a mild high bias in light
 * windows — the preferred failure direction for a quota warning.
 */
export function project5h(used: number, resetsAt: number, now: number, samples: readonly Sample[], since?: number | null): number {
  const ttr = Math.max(0, resetsAt - now);
  const windowAvg = projectWindow(used, ttr, WINDOW_LEN_S.five_hour);
  let avgRate: number | null = null;
  if (windowAvg !== null && ttr > 0) avgRate = Math.max(0, (windowAvg[0] - used) / ttr);
  let recent = rateFromSamples(samples, now, 3600.0, "five_hour", since);
  const fast = rateFromSamples(samples, now, 1800.0, "five_hour", since);
  if (fast !== null && (recent === null || fast > recent)) recent = fast;
  const learned = learnBucketRates(samples, "five_hour");
  const bucket = bucketForTime(now);
  const bucketRate = expectedBucketRate(bucket, learned[bucket]) / 3600.0;
  const rates: number[] = [];
  const weights: number[] = [];
  if (recent !== null) {
    rates.push(recent);
    weights.push(0.55);
  }
  if (avgRate !== null) {
    rates.push(avgRate);
    weights.push(recent !== null ? 0.3 : 0.75);
  }
  rates.push(bucketRate);
  weights.push(recent !== null ? 0.15 : 0.25);
  const totalW = weights.reduce((a, b) => a + b, 0);
  const blended = totalW ? rates.reduce((acc, r, i) => acc + r * weights[i]!, 0) / totalW : 0;
  return Math.max(used, Math.min(100, used + blended * ttr));
}

/**
 * Where the 7-day window ends: the time-of-day buckets integrated to the
 * reset; while burning, the rate measured over the last few hours carries the
 * next few (momentum may only RAISE the bucket estimate — an idle stretch
 * changes nothing); plus a tenth of the window-average projection's growth.
 */
export function project7d(used: number, resetsAt: number, now: number, samples: readonly Sample[], since?: number | null): number {
  const learned = learnBucketRates(samples, "seven_day");
  let future = integrateFutureBuckets(now, resetsAt, learned);
  const recent = rateFromSamples(samples, now, RECENT_MOMENTUM_HORIZON_S, "seven_day", since);
  if (recent !== null) {
    const horizon = Math.min(RECENT_MOMENTUM_HORIZON_S, Math.max(0, resetsAt - now));
    const bucketNear = integrateFutureBuckets(now, now + horizon, learned);
    future += Math.max(0, recent * horizon - bucketNear);
  }
  const ttr = Math.max(0, resetsAt - now);
  const windowAvg = projectWindow(used, ttr, WINDOW_LEN_S.seven_day);
  const sanity = windowAvg !== null ? Math.max(0, windowAvg[0] - used) * 0.1 : 0;
  return Math.max(used, Math.min(100, used + future + sanity));
}

/** Ease the displayed projection toward the raw one (time constant TAU), never below usage nor above 100. */
export function smoothProjection(
  window: WindowKey,
  raw: number,
  used: number,
  observedAt: number,
  previous?: DisplayState | null,
): DisplayState {
  const r = Math.max(used, Math.min(100, raw));
  if (!previous) return { projected_pct: r, updated_at: observedAt };
  const prevTs = num(previous.updated_at);
  const prevPct = num(previous.projected_pct);
  if (prevTs === null || prevPct === null) return { projected_pct: r, updated_at: observedAt };
  if (observedAt <= prevTs) return { projected_pct: Math.max(used, Math.min(100, prevPct)), updated_at: prevTs };
  const tau = TAU_SECONDS[window] ?? 900;
  const alpha = 1.0 - Math.exp(-(observedAt - prevTs) / tau);
  const smoothed = prevPct * (1.0 - alpha) + r * alpha;
  return { projected_pct: Math.max(used, Math.min(100, smoothed)), updated_at: observedAt };
}

export function recordProjectionSnapshot(
  store: ProjectionStore,
  window: WindowKey,
  observedAt: number,
  used: number,
  resetsAt: number,
  projected: number,
): void {
  store.snapshots.push({ window, observed_at: observedAt, used_pct: used, resets_at: resetsAt, model: "projection_v1", projected_pct: projected });
  if (store.snapshots.length > MAX_PROJECTION_SNAPSHOTS) store.snapshots.splice(0, store.snapshots.length - MAX_PROJECTION_SNAPSHOTS);
}

/** Note each window that rolled over (a later reset follows an earlier one) with how it actually ended. */
export function closeChangedWindows(store: ProjectionStore, window: WindowKey): void {
  const series = store[window];
  if (!Array.isArray(series) || series.length < 2) return;
  const closed = store.closed_windows;
  const seen = new Set(closed.map((c) => `${c.window}|${c.previous_resets_at}`));
  const ordered = [...series].sort((a, b) => (num(a.observed_at) ?? 0) - (num(b.observed_at) ?? 0));
  for (let i = 1; i < ordered.length; i++) {
    const prev = sampleNumbers(ordered[i - 1]);
    const cur = sampleNumbers(ordered[i]);
    if (prev === null || cur === null) continue;
    const [, prevUsed, prevReset] = prev;
    const [curTs, , curReset] = cur;
    const id = `${window}|${prevReset}`;
    if (curReset > prevReset && !seen.has(id)) {
      closed.push({ window, previous_resets_at: prevReset, actual_final_pct: prevUsed, closed_at: curTs });
      seen.add(id);
    }
  }
  if (closed.length > MAX_CLOSED_WINDOWS) closed.splice(0, closed.length - MAX_CLOSED_WINDOWS);
}

/**
 * The `→NN%` for one window: records the sample, then projects and smooths.
 * Null while it is too early in the window to trust (or nothing is used yet) —
 * the original's `→--` — unless a trustworthy projection already exists for
 * this very window, which is kept rather than flapping back. Holding off also
 * means the smoother later seeds from the first trustworthy raw value instead
 * of lagging behind a near-zero first tick. Rounded as the original's chip is,
 * since severity reads the rounded number.
 */
export function projectionForWindow(
  store: ProjectionStore,
  window: WindowKey,
  used: number,
  resetsAt: number,
  now: number,
  sessionId = "",
  since?: number | null,
): number | null {
  recordProjectionSample(store, window, used, resetsAt, now, sessionId);
  closeChangedWindows(store, window);

  const ttr = Math.max(0, resetsAt - now);
  const elapsed = WINDOW_LEN_S[window] - ttr;
  if (used <= 0 || elapsed < MIN_ELAPSED_S[window]) {
    const prev = store.display[window];
    if (prev && num(prev.resets_at) === resetsAt) return Math.round(Math.max(0, Math.min(100, num(prev.projected_pct) ?? 0)));
    return null;
  }

  const samples = samplesForReset(store[window], resetsAt);
  const raw = window === "five_hour" ? project5h(used, resetsAt, now, samples, since) : project7d(used, resetsAt, now, samples, since);
  let previous = store.display[window] ?? null;
  if (previous && num(previous.resets_at) !== resetsAt) previous = null;
  if (previous && since !== undefined && since !== null && (num(previous.updated_at) ?? 0) < since) {
    // Display state predates the regime boundary: jump to the new raw
    // projection instead of easing over from the old regime's estimate.
    previous = null;
  }
  const next: DisplayState = { ...smoothProjection(window, raw, used, now, previous), resets_at: resetsAt };
  store.display[window] = next;
  recordProjectionSnapshot(store, window, now, used, resetsAt, next.projected_pct);
  return Math.round(Math.max(0, Math.min(100, next.projected_pct)));
}
