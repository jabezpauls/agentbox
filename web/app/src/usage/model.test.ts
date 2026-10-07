import { describe, expect, it } from "vitest";
import type { ProviderUsage, UsageSnapshot, UsageWindow } from "@workbench/shared";

import fixture from "../store/fixtures/usage.json" with { type: "json" };
import {
  agentForPane,
  etaLeft,
  formatAgoShort,
  formatCountdown,
  limitedWindow,
  modelShort,
  severityClass,
  shownProviders,
  spokenCountdown,
  usageAlerts,
  type AlertMemory,
} from "./model.ts";

const base = fixture as unknown as UsageSnapshot;
const NOW = base.computedAt;

function claude(over: Partial<ProviderUsage> = {}, five: Partial<UsageWindow> = {}): UsageSnapshot {
  const u = structuredClone(base);
  const p = u.providers[0]!;
  Object.assign(p, over);
  Object.assign(p.fiveHour!, five);
  return u;
}

describe("countdowns", () => {
  it("reads like the status bar", () => {
    expect(formatCountdown(59)).toBe("59s");
    expect(formatCountdown(60)).toBe("1m");
    expect(formatCountdown(40 * 60 + 59)).toBe("40m");
    expect(formatCountdown(3 * 3600 + 7 * 60)).toBe("3h07m");
    expect(formatCountdown(4 * 86400 + 6 * 3600 + 120)).toBe("4d06h");
    expect(formatCountdown(-5)).toBe("0s");
  });

  it("says it in words for a screen reader", () => {
    expect(spokenCountdown(3 * 3600 + 7 * 60)).toBe("3 hours 7 minutes");
    expect(spokenCountdown(3600)).toBe("1 hour");
    expect(spokenCountdown(40 * 60)).toBe("40 minutes");
  });

  it("says how old a reading is", () => {
    expect(formatAgoShort(20)).toBe("just now");
    expect(formatAgoShort(6 * 60 + 10)).toBe("6m ago");
    expect(formatAgoShort(2 * 3600 + 900)).toBe("2h ago");
  });

  it("runs the ETA down from when the bridge computed it", () => {
    const w: UsageWindow = { usedPct: 80, resetsAt: NOW + 7200, projectedPct: 130, etaSeconds: 2400, severity: "hot" };
    expect(etaLeft(w, NOW, NOW)).toBe(2400);
    expect(etaLeft(w, NOW, NOW + 600)).toBe(1800);
    expect(etaLeft(w, NOW, NOW + 9999)).toBe(0);
    expect(etaLeft({ ...w, etaSeconds: null }, NOW, NOW)).toBeNull();
  });
});

describe("reading a snapshot", () => {
  it("puts Claude first and leaves out providers that have said nothing", () => {
    const u = structuredClone(base);
    u.providers.reverse();
    u.providers.push({ provider: "codex", fiveHour: null, sevenDay: null, observedAt: null, stale: false, limited: false });
    expect(shownProviders(u).map((p) => p.provider)).toEqual(["claude", "codex"]);
    expect(shownProviders(null)).toEqual([]);
  });

  it("maps a severity to its class", () => {
    expect(severityClass("ok")).toBe("is-ok");
    expect(severityClass("warn")).toBe("is-warn");
    expect(severityClass("hot")).toBe("is-hot");
  });

  it("finds which window is at its cap", () => {
    expect(limitedWindow(claude({ limited: true }, { usedPct: 100 }).providers[0]!)).toBe("fiveHour");
    const weekly = claude({ limited: true });
    weekly.providers[0]!.sevenDay!.usedPct = 100;
    expect(limitedWindow(weekly.providers[0]!)).toBe("sevenDay");
    expect(limitedWindow(base.providers[0]!)).toBeNull();
  });

  it("shortens model names and matches agents to panes", () => {
    expect(modelShort("Claude Sonnet 5 (1M context)")).toBe("Sonnet 5");
    expect(modelShort("Opus 5.5")).toBe("Opus 5.5");
    expect(modelShort(null)).toBeNull();
    expect(agentForPane(base, "w1:p2")?.model).toBe("Claude Sonnet 5 (1M context)");
    expect(agentForPane(base, "nope")).toBeNull();
  });
});

describe("usage alerts", () => {
  it("says nothing about an ordinary snapshot", () => {
    expect(usageAlerts(base, new Map(), NOW)).toEqual([]);
  });

  it("warns once when a window is headed for hot, not on every push", () => {
    const memory: AlertMemory = new Map();
    const hot = claude({}, { usedPct: 61, projectedPct: 93, severity: "hot" });
    const first = usageAlerts(hot, memory, NOW);
    expect(first).toHaveLength(1);
    expect(first[0]!.toast.title).toBe("Claude's 5-hour window is on pace for 93%");
    expect(usageAlerts(hot, memory, NOW + 60)).toEqual([]);
    expect(usageAlerts({ ...hot, computedAt: NOW + 300 }, memory, NOW + 300)).toEqual([]);
  });

  it("warns again in the next window", () => {
    const memory: AlertMemory = new Map();
    const hot = claude({}, { projectedPct: 93, severity: "hot" });
    usageAlerts(hot, memory, NOW);
    const next = claude({}, { projectedPct: 95, severity: "hot", resetsAt: hot.providers[0]!.fiveHour!.resetsAt + 5 * 3600 });
    expect(usageAlerts(next, memory, NOW)).toHaveLength(1);
  });

  it("says an ETA when it first appears, even after the hot warning", () => {
    const memory: AlertMemory = new Map();
    usageAlerts(claude({}, { projectedPct: 93, severity: "hot" }), memory, NOW);
    const eta = claude({}, { usedPct: 84, projectedPct: 140, etaSeconds: 2400, severity: "hot" });
    const out = usageAlerts(eta, memory, NOW);
    expect(out.map((a) => a.toast.title)).toEqual(["Claude's 5-hour limit in about 40m"]);
    expect(usageAlerts(eta, memory, NOW + 30)).toEqual([]);
  });

  it("an ETA and a hot projection at once are one toast", () => {
    const eta = claude({}, { usedPct: 84, projectedPct: 140, etaSeconds: 2400, severity: "hot" });
    expect(usageAlerts(eta, new Map(), NOW)).toHaveLength(1);
  });

  it("says a reached limit with the time agents will wait until", () => {
    const memory: AlertMemory = new Map();
    const limited = claude({ limited: true }, { usedPct: 100, projectedPct: 140, etaSeconds: 0, severity: "hot" });
    const out = usageAlerts(limited, memory, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.toast.kind).toBe("limit");
    expect(out[0]!.toast.title).toMatch(/^Claude's 5-hour limit is reached; agents will wait until \S+/);
    expect(usageAlerts(limited, memory, NOW + 60)).toEqual([]);
  });

  it("raises nothing about pace from a stale reading", () => {
    const stale = claude({ stale: true }, { projectedPct: 93, etaSeconds: 1200, severity: "hot" });
    expect(usageAlerts(stale, new Map(), NOW)).toEqual([]);
  });

  it("raises nothing about a window that has already reset", () => {
    const old = claude({ limited: true }, { usedPct: 100, resetsAt: NOW - 60 });
    expect(usageAlerts(old, new Map(), NOW)).toEqual([]);
  });
});
