/**
 * Severity bands for the usage meters, from claude-statusbar's `progress.py`
 * (3.21.1, https://github.com/leeguooooo/claude-code-usage-bar,
 * Copyright (c) 2024 leeguooooo, MIT; the full notice is in predict.ts).
 */
import type { UsageSeverity } from "@workbench/shared";

/**
 * Without a projection, a window is judged by its current usage on the
 * comfort band: warn from 30%, hot from 70%.
 */
export const WARNING_THRESHOLD = 30;
export const CRITICAL_THRESHOLD = 70;
/**
 * Once there is a `→NN%` projection the window colours by where it is headed,
 * against the cap. Hot starts well below 100 on purpose: a projection of 85%+
 * means the window is essentially going to run out (and the slow 7-day
 * projection can sit at a clamped 99 for ages; it should read as alarming).
 */
export const PROJECTION_WARNING_THRESHOLD = 70;
export const PROJECTION_CRITICAL_THRESHOLD = 85;
/**
 * The context window fills toward auto-compaction, which only matters near the
 * top, so 30% used reads calm: warn 70, hot 85 (claude-hud's thresholds).
 */
export const CONTEXT_WARNING_THRESHOLD = 70;
export const CONTEXT_CRITICAL_THRESHOLD = 85;

function band(pct: number, warning: number, critical: number): UsageSeverity {
  if (pct >= critical) return "hot";
  if (pct >= warning) return "warn";
  return "ok";
}

/** A 5h or 7d window: by its projection when there is one, else by current usage. */
export function windowSeverity(usedPct: number, projectedPct: number | null): UsageSeverity {
  if (projectedPct !== null) return band(projectedPct, PROJECTION_WARNING_THRESHOLD, PROJECTION_CRITICAL_THRESHOLD);
  return band(usedPct, WARNING_THRESHOLD, CRITICAL_THRESHOLD);
}

export function contextSeverity(contextPct: number | null): UsageSeverity {
  if (contextPct === null) return "ok";
  return band(contextPct, CONTEXT_WARNING_THRESHOLD, CONTEXT_CRITICAL_THRESHOLD);
}
