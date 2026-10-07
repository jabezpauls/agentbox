import type { AgentUsage, ProviderUsage, UsageProvider, UsageSeverity, UsageSnapshot, UsageWindow } from "@workbench/shared";
import type { Toast } from "../notify.ts";

/**
 * Plan usage, the way the Workbench says it: the same short register as a
 * terminal status bar ("21%", "→72%", "3h07m", "~40m"), worked out from the
 * bridge's snapshot. The bridge pushes on change and on a slow timer, so every
 * countdown here runs from the snapshot's own clock, never from the push.
 */

export type WindowKey = "fiveHour" | "sevenDay";

export const WINDOWS: { key: WindowKey; short: string; long: string }[] = [
  { key: "fiveHour", short: "5h", long: "5-hour" },
  { key: "sevenDay", short: "7d", long: "weekly" },
];

const PROVIDER_NAMES: Record<UsageProvider, string> = { claude: "Claude", codex: "Codex" };
const PROVIDER_ORDER: Record<UsageProvider, number> = { claude: 0, codex: 1 };

export function providerName(p: UsageProvider): string {
  return PROVIDER_NAMES[p] ?? p;
}

/** A provider is worth a meter once it has reported at least one window. */
export function hasData(p: ProviderUsage): boolean {
  return p.fiveHour !== null || p.sevenDay !== null;
}

/** The providers to show, Claude first; none at all when nothing has reported. */
export function shownProviders(u: UsageSnapshot | null): ProviderUsage[] {
  if (!u) return [];
  return u.providers.filter(hasData).sort((a, b) => (PROVIDER_ORDER[a.provider] ?? 9) - (PROVIDER_ORDER[b.provider] ?? 9));
}

/** A countdown, the status bar's way: "59s", "40m", "3h07m", "4d06h". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
}

/** The same span in words, for a screen reader: "3 hours 7 minutes". */
export function spokenCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (s < 60) return unit(s, "second");
  const m = Math.floor(s / 60);
  if (m < 60) return unit(m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${unit(h, "hour")} ${unit(m % 60, "minute")}` : unit(h, "hour");
  return h % 24 ? `${unit(Math.floor(h / 24), "day")} ${unit(h % 24, "hour")}` : unit(Math.floor(h / 24), "day");
}

/** How long ago, short: "just now", "6m ago", "2h ago". */
export function formatAgoShort(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/**
 * The wall-clock time a window resets, in the browser's locale: "8:00 PM",
 * or "Thu 8:00 PM" when it is not within the next day.
 */
export function resetClock(resetsAt: number, now: number): string {
  const d = new Date(resetsAt * 1000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (resetsAt - now < 20 * 3600) return time;
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** Seconds until the window resets. */
export function untilReset(w: UsageWindow, now: number): number {
  return Math.max(0, w.resetsAt - now);
}

/**
 * Seconds left to the cap at the current pace. The bridge worked it out at
 * `computedAt`; the clock has run since.
 */
export function etaLeft(w: UsageWindow, computedAt: number, now: number): number | null {
  if (w.etaSeconds === null) return null;
  return Math.max(0, w.etaSeconds - Math.max(0, now - computedAt));
}

/** The window that has hit its cap — the 5-hour one first — or null. */
export function limitedWindow(p: ProviderUsage): WindowKey | null {
  if (!p.limited) return null;
  if (p.fiveHour && p.fiveHour.usedPct >= 100) return "fiveHour";
  if (p.sevenDay && p.sevenDay.usedPct >= 100) return "sevenDay";
  // Limited, but neither window says 100% (Codex rounds): the fuller one.
  if (p.fiveHour && p.sevenDay) return p.sevenDay.usedPct > p.fiveHour.usedPct ? "sevenDay" : "fiveHour";
  return p.fiveHour ? "fiveHour" : p.sevenDay ? "sevenDay" : null;
}

/** The soonest cap a provider is heading for: which window, and how long. */
export function soonestEta(p: ProviderUsage, computedAt: number, now: number): { key: WindowKey; seconds: number } | null {
  let best: { key: WindowKey; seconds: number } | null = null;
  for (const { key } of WINDOWS) {
    const w = p[key];
    const s = w ? etaLeft(w, computedAt, now) : null;
    if (s !== null && (best === null || s < best.seconds)) best = { key, seconds: s };
  }
  return best;
}

export function windowLong(key: WindowKey): string {
  return WINDOWS.find((w) => w.key === key)!.long;
}

/** A severity as the class every usage colour hangs off. */
export function severityClass(s: UsageSeverity): string {
  return `is-${s === "hot" || s === "warn" ? s : "ok"}`;
}

/**
 * The model as a row has room for: "Opus 5.5", not "Claude Opus 5.5 (1M
 * context)".
 */
export function modelShort(model: string | null): string | null {
  if (!model) return null;
  const s = model.replace(/\s*\(.*?\)\s*/g, " ").replace(/^claude[\s-]+/i, "").trim();
  return s || model;
}

/** The newest report from the agent in a pane: the list is newest first. */
export function agentForPane(u: UsageSnapshot | null, paneId: string): AgentUsage | null {
  return u?.agents.find((a) => a.paneId === paneId) ?? null;
}

/* --- alerts ------------------------------------------------------------------ */

export interface UsageAlert {
  toast: Toast;
  /** What makes two alerts the same toast row. */
  dedupe: string;
}

/**
 * What has been said, per provider, window and kind, with the reset of the
 * window it was said about. A new window (its reset moved on) may be said
 * again; the same window, pushed again and again, may not.
 */
export type AlertMemory = Map<string, number>;

/** Resets within this many seconds of each other are the same window. */
const SAME_WINDOW_S = 30 * 60;

function fresh(memory: AlertMemory, key: string, resetsAt: number): boolean {
  const said = memory.get(key);
  if (said !== undefined && Math.abs(resetsAt - said) < SAME_WINDOW_S) return false;
  memory.set(key, resetsAt);
  return true;
}

/**
 * The toasts a snapshot is worth, once each: a provider whose limit is
 * reached; a window that will reach its cap within the hour; a window headed
 * for "hot" by its projection. The limit says the most and silences the
 * others for that provider; an ETA says more than a projection. Old readings
 * (stale, or of a window that has already reset) raise nothing new about
 * pace.
 */
export function usageAlerts(u: UsageSnapshot, memory: AlertMemory, now: number): UsageAlert[] {
  const out: UsageAlert[] = [];
  for (const p of shownProviders(u)) {
    const name = providerName(p.provider);
    const limited = limitedWindow(p);
    if (limited) {
      const w = p[limited]!;
      if (w.resetsAt > now && fresh(memory, `${p.provider}:${limited}:limited`, w.resetsAt)) {
        out.push({
          dedupe: `usage:${p.provider}:limited`,
          toast: {
            kind: "limit",
            paneId: "",
            // The title is one line in the toast: the wait goes on the second.
            title: `${name}'s ${windowLong(limited)} limit is reached`,
            detail: `Agents will wait until ${resetClock(w.resetsAt, now)}, ${formatCountdown(untilReset(w, now))} from now.`,
          },
        });
      }
      continue;
    }
    if (p.stale) continue;
    for (const { key } of WINDOWS) {
      const w = p[key];
      if (!w || w.resetsAt <= now) continue;
      const eta = etaLeft(w, u.computedAt, now);
      if (eta !== null) {
        // An ETA is a hot projection and then some: one toast covers both.
        const etaNew = fresh(memory, `${p.provider}:${key}:eta`, w.resetsAt);
        const hotNew = fresh(memory, `${p.provider}:${key}:hot`, w.resetsAt);
        if (etaNew || hotNew) {
          out.push({
            dedupe: `usage:${p.provider}:${key}`,
            toast: {
              kind: "usage",
              paneId: "",
              title: `${name}'s ${windowLong(key)} limit in about ${formatCountdown(eta)}`,
              detail: `At this pace. ${w.usedPct}% used; it resets at ${resetClock(w.resetsAt, now)}.`,
            },
          });
        }
      } else if (w.severity === "hot" && w.projectedPct !== null && fresh(memory, `${p.provider}:${key}:hot`, w.resetsAt)) {
        out.push({
          dedupe: `usage:${p.provider}:${key}`,
          toast: {
            kind: "usage",
            paneId: "",
            title: `${name}'s ${windowLong(key)} window is on pace for ${Math.round(Math.min(100, w.projectedPct))}%`,
            detail: `${w.usedPct}% used so far; it resets at ${resetClock(w.resetsAt, now)}.`,
          },
        });
      }
    }
  }
  return out;
}

/** Any provider refusing work: what the rail and Home lead with. */
export function anyLimited(u: UsageSnapshot | null): boolean {
  return shownProviders(u).some((p) => p.limited);
}
