import { describe, expect, it } from "vitest";
import {
  bucketForTime,
  closeChangedWindows,
  DOWNGRADE_GRACE_S,
  emptyAccountStore,
  emptyProjectionStore,
  forecastEta,
  integrateFutureBuckets,
  learnBucketRates,
  project5h,
  project7d,
  projectionForWindow,
  rateFromSamples,
  reconcileAccount,
  recordProjectionSample,
  RL_IDLE_TTL_S,
  smoothProjection,
  type RateReading,
  type Sample,
} from "../src/usage/predict.js";
import { contextSeverity, windowSeverity } from "../src/usage/severity.js";

// The forecast is claude-statusbar's, ported; these are the behaviours its
// comments promise, held to here. Time-of-day buckets read local time, so the
// clock is pinned to UTC for the arithmetic below to come out as written.
process.env.TZ = "UTC";

/** Wednesday 2026-10-07, 12:00 UTC: weekday work hours. */
const NOON = Date.UTC(2026, 9, 7, 12, 0, 0) / 1000;
const H = 3600;

function reading(used5h: number | null, resets5h: number | null, used7d: number | null = null, resets7d: number | null = null): RateReading {
  return { used5h, resets5h, used7d, resets7d };
}

describe("the end-of-window projection", () => {
  it("is held back early in a window, then given", () => {
    const store = emptyProjectionStore();
    const reset = NOON + 5 * H - 5 * 60; // five minutes into the window
    expect(projectionForWindow(store, "five_hour", 3, reset, NOON)).toBeNull();
    // The sample is still recorded, so history is ready when the gate opens.
    expect(store.five_hour).toHaveLength(1);
    const later = NOON + 6 * 60; // eleven minutes in
    expect(projectionForWindow(store, "five_hour", 4, reset, later)).toEqual(expect.any(Number));
  });

  it("is held back while nothing is used", () => {
    expect(projectionForWindow(emptyProjectionStore(), "five_hour", 0, NOON + 2 * H, NOON)).toBeNull();
  });

  it("keeps a projection it already made for the same window when the floor dips back", () => {
    const store = emptyProjectionStore();
    const reset = NOON + 4 * H;
    const p = projectionForWindow(store, "five_hour", 20, reset, NOON);
    expect(p).not.toBeNull();
    store.display.five_hour!.projected_pct = 61.4;
    // A clock jitter that puts elapsed under the minimum: the same window's projection stays.
    expect(projectionForWindow(store, "five_hour", 20, reset, reset - 5 * H + 60)).toBe(61);
  });

  it("blends recent pace 0.55, window average 0.30 and the time-of-day bucket 0.15", () => {
    const reset = NOON + 3 * H; // two hours into the window
    const samples: Sample[] = [
      { observed_at: NOON - 1200, used_pct: 35, resets_at: reset },
      { observed_at: NOON - 600, used_pct: 37, resets_at: reset },
    ];
    // recent 12 %/h; window average 37/2h = 18.5 %/h; the work-hours bucket,
    // its 0.45 prior moved 1/20 of the way toward the one learned delta (12).
    const bucket = 0.45 * 0.95 + 12 * 0.05;
    const blended = 0.55 * 12 + 0.3 * 18.5 + 0.15 * bucket;
    expect(project5h(37, reset, NOON, samples)).toBeCloseTo(37 + blended * 3, 6);
  });

  it("weighs the window average 0.75 and the bucket 0.25 without a recent pace", () => {
    const reset = NOON + 3 * H;
    expect(project5h(37, reset, NOON, [])).toBeCloseTo(37 + (0.75 * 18.5 + 0.25 * 0.45) * 3, 6);
  });

  it("takes the faster of the last hour and the last half hour", () => {
    const reset = NOON + 3 * H;
    const samples: Sample[] = [
      { observed_at: NOON - 3000, used_pct: 30, resets_at: reset },
      { observed_at: NOON - 1500, used_pct: 31, resets_at: reset },
      { observed_at: NOON - 300, used_pct: 37, resets_at: reset },
    ];
    // Over the hour: 7% in 2700s; over the half hour: 6% in 1200s — faster.
    expect(rateFromSamples(samples, NOON, 3600, "five_hour")).toBeCloseTo(7 / 2700, 9);
    expect(rateFromSamples(samples, NOON, 1800, "five_hour")).toBeCloseTo(6 / 1200, 9);
    const withFast = project5h(37, reset, NOON, samples);
    const hourOnly = project5h(37, reset, NOON, samples.slice(0, 1).concat(samples.slice(2)));
    expect(withFast).toBeGreaterThan(hourOnly - 1e-9);
  });

  it("ignores an implausibly fast or too-short recent pace", () => {
    const reset = NOON + 3 * H;
    const short: Sample[] = [
      { observed_at: NOON - 100, used_pct: 30, resets_at: reset },
      { observed_at: NOON - 10, used_pct: 31, resets_at: reset },
    ];
    expect(rateFromSamples(short, NOON, 3600, "five_hour")).toBeNull();
    const absurd: Sample[] = [
      { observed_at: NOON - 600, used_pct: 10, resets_at: reset },
      { observed_at: NOON - 1, used_pct: 30, resets_at: reset },
    ];
    expect(rateFromSamples(absurd, NOON, 3600, "five_hour")).toBeNull(); // 120 %/h > 60
  });

  it("lets 7-day momentum raise the projection, never lower it", () => {
    const reset = NOON + 3 * 86400;
    const base = project7d(40, reset, NOON, []);
    // An idle stretch: no growth, so no recent rate, and nothing changes.
    const idle: Sample[] = [
      { observed_at: NOON - 2 * H, used_pct: 40, resets_at: reset },
      { observed_at: NOON - H, used_pct: 40, resets_at: reset },
    ];
    expect(project7d(40, reset, NOON, idle)).toBeCloseTo(base, 9);
    // A slow burn (below the bucket rate): what it learned shifts the buckets,
    // but the momentum term itself adds nothing.
    const slow: Sample[] = [
      { observed_at: NOON - 2 * H, used_pct: 39.9, resets_at: reset },
      { observed_at: NOON - H, used_pct: 40, resets_at: reset },
    ];
    const learned = learnBucketRates(slow, "seven_day");
    const noMomentum = 40 + integrateFutureBuckets(NOON, reset, learned) + (40 * (7 * 86400) / (4 * 86400) - 40) * 0.1;
    expect(project7d(40, reset, NOON, slow)).toBeCloseTo(Math.min(100, noMomentum), 9);
    // A hard burn: 4% in the last two hours carries the next three.
    const hard: Sample[] = [
      { observed_at: NOON - 2 * H, used_pct: 36, resets_at: reset },
      { observed_at: NOON - 1, used_pct: 40, resets_at: reset },
    ];
    expect(project7d(40, reset, NOON, hard)).toBeGreaterThan(base);
  });

  it("smooths toward the raw projection, never below usage nor above 100", () => {
    expect(smoothProjection("five_hour", 120, 30, NOON).projected_pct).toBe(100);
    expect(smoothProjection("five_hour", 10, 30, NOON).projected_pct).toBe(30);
    const prev = { projected_pct: 50, updated_at: NOON };
    // One time constant (8 minutes for the 5-hour window) later.
    const next = smoothProjection("five_hour", 80, 30, NOON + 480, prev);
    expect(next.projected_pct).toBeCloseTo(50 * Math.exp(-1) + 80 * (1 - Math.exp(-1)), 9);
    // Never backwards in time; and clamped to current usage even then.
    expect(smoothProjection("five_hour", 80, 60, NOON - 10, prev)).toEqual({ projected_pct: 60, updated_at: NOON });
  });

  it("jumps to a new regime's projection rather than easing over from the old one", () => {
    const reset = NOON + 3 * H;
    const store = emptyProjectionStore();
    store.display.five_hour = { projected_pct: 40, updated_at: NOON - 600, resets_at: reset };
    const eased = projectionForWindow(structuredClone(store), "five_hour", 37, reset, NOON);
    const jumped = projectionForWindow(store, "five_hour", 37, reset, NOON, "", NOON - 300);
    const raw = Math.round(project5h(37, reset, NOON, store.five_hour, NOON - 300));
    expect(jumped).toBe(raw);
    expect(eased).not.toBe(raw);
  });

  it("clips the recent pace to a regime boundary, with a shorter minimum span", () => {
    const reset = NOON + 3 * H;
    const samples: Sample[] = [
      { observed_at: NOON - 3000, used_pct: 20, resets_at: reset },
      { observed_at: NOON - 200, used_pct: 22, resets_at: reset },
      { observed_at: NOON - 50, used_pct: 24, resets_at: reset },
    ];
    expect(rateFromSamples(samples, NOON, 3600, "five_hour")).toBeCloseTo(4 / 2950, 9);
    // Since the switch (250s ago) only the last two count: 2% in 150s, a span
    // too short without a boundary (300s) but enough right after one (120s).
    expect(rateFromSamples(samples, NOON, 3600, "five_hour", NOON - 250)).toBeCloseTo(2 / 150, 9);
    expect(rateFromSamples(samples.slice(1), NOON, 3600, "five_hour")).toBeNull();
  });
});

describe("the near-cap ETA", () => {
  it("is given only when the window is projected to hit 100% within the hour", () => {
    const reset = NOON + H; // four hours in
    // 90% in four hours: 22.5 %/h, so 100% in 10/22.5 hours.
    expect(forecastEta("five_hour", 90, reset, NOON)).toBe(Math.floor((10 / 22.5) * 3600));
    // On track to end at 62.5%: no ETA.
    expect(forecastEta("five_hour", 50, reset, NOON)).toBeNull();
    // Headed past 100%, but three days out: the projection says enough.
    expect(forecastEta("seven_day", 50, NOON + 4 * 86400, NOON)).toBeNull();
  });

  it("is never given too early in a window, nor when capped or reset", () => {
    expect(forecastEta("five_hour", 9, NOON + 5 * H - 300, NOON)).toBeNull();
    expect(forecastEta("five_hour", 100, NOON + H, NOON)).toBeNull();
    expect(forecastEta("five_hour", 90, NOON - 1, NOON)).toBeNull();
  });
});

describe("reconciling the sessions' readings", () => {
  const R5 = NOON + 2 * H;
  const R7 = NOON + 3 * 86400;

  it("only lets usage grow within a window", () => {
    const store = emptyAccountStore();
    expect(reconcileAccount(store, reading(40, R5), NOON, { sessionId: "a" })).toMatchObject({ used5h: 40, live: true });
    // Another session with an older view of the same window.
    expect(reconcileAccount(store, reading(35, R5), NOON + 5, { sessionId: "b" })).toMatchObject({ used5h: 40 });
    expect(reconcileAccount(store, reading(45, R5), NOON + 10, { sessionId: "b" })).toMatchObject({ used5h: 45 });
  });

  it("accepts a lower reading once the higher one has gone unconfirmed for the grace period", () => {
    const store = emptyAccountStore();
    reconcileAccount(store, reading(19, R5), NOON, { sessionId: "a" });
    expect(reconcileAccount(store, reading(3, R5), NOON + 60, { sessionId: "b" }).used5h).toBe(19);
    expect(reconcileAccount(store, reading(3, R5), NOON + DOWNGRADE_GRACE_S + 1, { sessionId: "b" }).used5h).toBe(3);
    expect(store.five_hour[String(R5)]).toEqual({ used: 3, observed_at: NOON + DOWNGRADE_GRACE_S + 1 });
  });

  it("lets a live session's agreement hold the higher reading", () => {
    const store = emptyAccountStore();
    reconcileAccount(store, reading(19, R5), NOON, { sessionId: "a" });
    // a keeps seeing 19 (it is live: no session id, so no frozen gate).
    for (let t = 20; t <= 300; t += 20) reconcileAccount(store, reading(19, R5), NOON + t);
    expect(reconcileAccount(store, reading(3, R5), NOON + 300, { sessionId: "b" }).used5h).toBe(19);
  });

  it("stops a frozen replay from confirming once its numbers have not moved for RL_IDLE_TTL_S", () => {
    const store = emptyAccountStore();
    // a reports 63% and then sits idle, replaying the same blob.
    for (let t = 0; t <= RL_IDLE_TTL_S + 200; t += 20) {
      reconcileAccount(store, reading(63, R5, 63, R7), NOON + t, { sessionId: "a" });
    }
    // Its last confirmation landed at RL_IDLE_TTL_S; the official re-baseline
    // to 2% from a live session waits out the grace period from there...
    const t1 = NOON + RL_IDLE_TTL_S + 60;
    expect(reconcileAccount(store, reading(2, R5, 2, R7), t1, { sessionId: "b" })).toMatchObject({ used5h: 63, used7d: 63 });
    // ...and then lands, though a keeps replaying 63%.
    reconcileAccount(store, reading(63, R5, 63, R7), NOON + RL_IDLE_TTL_S + 140, { sessionId: "a" });
    const t2 = NOON + RL_IDLE_TTL_S + DOWNGRADE_GRACE_S + 1;
    expect(reconcileAccount(store, reading(2, R5, 2, R7), t2, { sessionId: "b" })).toMatchObject({ used5h: 2, used7d: 2 });
    // a still displays the shared reading, not its frozen one, and is not live.
    expect(reconcileAccount(store, reading(63, R5, 63, R7), t2 + 1, { sessionId: "a" })).toMatchObject({ used5h: 2, used7d: 2, live: false });
  });

  it("keeps readings of different resets apart: two accounts' windows coexist", () => {
    const store = emptyAccountStore();
    const other = R5 + 3600;
    reconcileAccount(store, reading(77, R5), NOON, { sessionId: "a" });
    reconcileAccount(store, reading(14, other), NOON + 1, { sessionId: "b" });
    expect(Object.keys(store.five_hour).sort()).toEqual([String(R5), String(other)]);
    expect(reconcileAccount(store, reading(77, R5), NOON + 2, { sessionId: "a" }).used5h).toBe(77);
    expect(reconcileAccount(store, reading(14, other), NOON + 3, { sessionId: "b" }).used5h).toBe(14);
  });

  it("refuses resets that cannot be real, and dates the whole blob by them", () => {
    const store = emptyAccountStore();
    const r = reconcileAccount(store, reading(50, NOON + 1e9, 40, R7), NOON, { sessionId: "a" });
    expect(r.live).toBe(false);
    expect(store.five_hour).toEqual({});
    // The 7-day half looked fine, but the blob is dated by its other half.
    expect(store.seven_day).toEqual({});
    // A 5-hour reset in the past is an old blob too.
    reconcileAccount(store, reading(50, NOON - 3600, 40, R7), NOON, { sessionId: "b" });
    expect(store.seven_day).toEqual({});
    // Nor does a far-future reset get into the projection's history.
    const p = emptyProjectionStore();
    recordProjectionSample(p, "five_hour", 50, NOON + 1e9, NOON);
    expect(p.five_hour).toEqual([]);
  });

  it("does not write when asked only to answer", () => {
    const store = emptyAccountStore();
    reconcileAccount(store, reading(10, R5), NOON, { sessionId: "a", record: false });
    expect(store).toEqual(emptyAccountStore());
  });

  it("marks a regime boundary on a model switch and when a new model joins the fleet", () => {
    const store = emptyAccountStore();
    reconcileAccount(store, reading(10, R5), NOON, { sessionId: "a", model: "opus" });
    expect(store.regime).toBeUndefined();
    // Another session on the same model joins: same regime.
    reconcileAccount(store, reading(10, R5), NOON + 10, { sessionId: "b", model: "opus" });
    expect(store.regime).toBeUndefined();
    reconcileAccount(store, reading(11, R5), NOON + 20, { sessionId: "a", model: "sonnet" });
    expect(store.regime).toEqual({ changed_at: NOON + 20, reason: "model-switch", model: "sonnet" });
    reconcileAccount(store, reading(12, R5), NOON + 30, { sessionId: "c", model: "haiku" });
    expect(store.regime).toEqual({ changed_at: NOON + 30, reason: "fleet-join", model: "haiku" });
  });
});

describe("the projection's history", () => {
  it("drops a window's samples when its limit is re-baselined, and leaves other windows' alone", () => {
    const store = emptyProjectionStore();
    const r = NOON + 2 * H;
    const other = NOON + 3 * H;
    recordProjectionSample(store, "five_hour", 10, r, NOON - 600);
    recordProjectionSample(store, "five_hour", 20, r, NOON - 300);
    recordProjectionSample(store, "five_hour", 50, other, NOON - 200);
    store.display.five_hour = { projected_pct: 60, updated_at: NOON - 300, resets_at: r };
    // The same reading again is not a new sample.
    recordProjectionSample(store, "five_hour", 20, r, NOON - 100);
    expect(store.five_hour).toHaveLength(3);
    recordProjectionSample(store, "five_hour", 5, r, NOON);
    expect(store.five_hour.map((s) => [s.used_pct, s.resets_at])).toEqual([
      [50, other],
      [5, r],
    ]);
    expect(store.display.five_hour).toBeUndefined();
  });

  it("records how a window ended when the next one begins", () => {
    const store = emptyProjectionStore();
    const r1 = NOON + 600;
    recordProjectionSample(store, "five_hour", 70, r1, NOON);
    recordProjectionSample(store, "five_hour", 3, r1 + 5 * H, NOON + 900);
    closeChangedWindows(store, "five_hour");
    closeChangedWindows(store, "five_hour");
    expect(store.closed_windows).toEqual([{ window: "five_hour", previous_resets_at: r1, actual_final_pct: 70, closed_at: NOON + 900 }]);
  });

  it("buckets time of day by local time", () => {
    expect(bucketForTime(NOON)).toBe("weekday_work_hours");
    expect(bucketForTime(NOON - 9 * H)).toBe("night"); // 03:00
    expect(bucketForTime(NOON + 8 * H)).toBe("weekday_non_work_hours"); // 20:00
    expect(bucketForTime(NOON + 3 * 86400)).toBe("weekend"); // Saturday noon
  });
});

describe("severity", () => {
  it("follows the projection when there is one: warn 70, hot 85", () => {
    expect(windowSeverity(10, 69)).toBe("ok");
    expect(windowSeverity(10, 70)).toBe("warn");
    expect(windowSeverity(10, 85)).toBe("hot");
  });

  it("falls back to current usage without one: warn 30, hot 70", () => {
    expect(windowSeverity(29, null)).toBe("ok");
    expect(windowSeverity(30, null)).toBe("warn");
    expect(windowSeverity(70, null)).toBe("hot");
    // A projection overrules usage both ways.
    expect(windowSeverity(50, 60)).toBe("ok");
  });

  it("judges the context window on warn 70, hot 85", () => {
    expect(contextSeverity(null)).toBe("ok");
    expect(contextSeverity(35)).toBe("ok");
    expect(contextSeverity(70)).toBe("warn");
    expect(contextSeverity(85)).toBe("hot");
  });
});
