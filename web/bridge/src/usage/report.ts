import type { UsageProvider } from "@workbench/shared";
import type { RateReading } from "./predict.js";

/**
 * One session's report, from either harness: what the usage service ingests.
 * Claude Code's comes from its status line (via agentbox-status); Codex's
 * from a token-count event in its session log.
 */
export interface UsageReport {
  provider: UsageProvider;
  sessionId: string;
  /** The herdr pane the agent runs in, when it told us. */
  paneId: string | null;
  /** When the reading was taken: epoch seconds. */
  at: number;
  /** The model as the harness names it for people ("Opus 5.5"), and its id. */
  model: string | null;
  modelId: string | null;
  contextPct: number | null;
  contextSize: number | null;
  /** The account's windows as this session last saw them; null when it carried none. */
  rates: RateReading | null;
  /**
   * Something that changes whenever the session talks to the API: the
   * harness refreshes its rate limits only then, so a change here means the
   * reading behind `rates` is current even when the percentages did not move.
   */
  activity: string | null;
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function obj(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function str(x: unknown, max = 200): string | null {
  return typeof x === "string" && x.length > 0 && x.length <= max ? x : null;
}

const PANE_ID = /^[A-Za-z0-9:._-]{1,64}$/;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** A pane id as herdr hands it to the pane's processes, or null for anything else. */
export function paneIdOf(x: unknown): string | null {
  return typeof x === "string" && PANE_ID.test(x) ? x : null;
}

/**
 * Claude Code's status-line JSON (what it writes to the status line command's
 * stdin), less everything the meters do not use; null when it is not one.
 * `rate_limits` is present only for subscription plans, and only once the
 * session has talked to the API.
 */
export function parseClaudeStatus(status: unknown, paneId: string | null, at: number): UsageReport | null {
  const s = obj(status);
  if (!s) return null;
  const sessionId = typeof s.session_id === "string" && SESSION_ID.test(s.session_id) ? s.session_id : null;
  if (!sessionId) return null;

  const model = obj(s.model);
  const ctx = obj(s.context_window);
  const rl = obj(s.rate_limits);
  const five = obj(rl?.five_hour);
  const seven = obj(rl?.seven_day);
  const rates: RateReading | null =
    five || seven
      ? {
          used5h: num(five?.used_percentage),
          resets5h: num(five?.resets_at),
          used7d: num(seven?.used_percentage),
          resets7d: num(seven?.resets_at),
        }
      : null;

  const cost = obj(s.cost);
  const apiMs = num(cost?.total_api_duration_ms);
  const tokens = [num(ctx?.total_input_tokens), num(ctx?.total_output_tokens)];
  const activity = apiMs !== null || tokens.some((t) => t !== null) ? [apiMs, ...tokens].join("/") : null;

  const contextPct = num(ctx?.used_percentage);
  const contextSize = num(ctx?.context_window_size);
  return {
    provider: "claude",
    sessionId,
    paneId,
    at,
    model: str(model?.display_name) ?? str(model?.id),
    modelId: str(model?.id),
    contextPct: contextPct === null ? null : Math.max(0, Math.min(100, contextPct)),
    contextSize: contextSize !== null && contextSize > 0 ? contextSize : null,
    rates,
    activity,
  };
}
