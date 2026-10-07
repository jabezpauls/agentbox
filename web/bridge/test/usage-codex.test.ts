import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexSessions, codexRates } from "../src/usage/codex.js";
import { UsageService } from "../src/usage/service.js";

// Codex's session logs, in the shapes its source writes them
// (openai/codex codex-rs/protocol: RolloutLine, EventMsg::TokenCount,
// RateLimitSnapshot), read the way the bridge polls them.

const NOW = Date.UTC(2026, 9, 7, 9, 20, 0) / 1000;
const ID = "019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b";

const META = { timestamp: "2026-10-07T09:14:02.118Z", type: "session_meta", payload: { id: ID, timestamp: "2026-10-07T09:14:02.101Z", cwd: "/workspace/demo", originator: "codex_cli_rs", cli_version: "0.161.0" } };
const TURN = { timestamp: "2026-10-07T09:14:05.400Z", type: "turn_context", payload: { cwd: "/workspace/demo", model: "gpt-5-codex", approval_policy: "on-request" } };
const STARTED = { timestamp: "2026-10-07T09:14:05.442Z", type: "event_msg", payload: { type: "task_started", turn_id: "1", model_context_window: 272000 } };
const usage = (total: number) => ({ input_tokens: total - 400, cached_input_tokens: 0, output_tokens: 400, reasoning_output_tokens: 0, total_tokens: total });
const NO_LIMITS = {
  timestamp: "2026-10-07T09:14:09.870Z",
  type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: usage(11646), last_token_usage: usage(11646), model_context_window: 272000 }, rate_limits: null },
};
function counted(ts: string, primary: number, secondary: number, extra: Record<string, unknown> = {}) {
  return {
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: usage(25315), last_token_usage: usage(13600), model_context_window: 272000 },
      rate_limits: {
        limit_id: "codex",
        limit_name: null,
        primary: { used_percent: primary, window_minutes: 300, resets_at: NOW + 2 * 3600 },
        secondary: { used_percent: secondary, window_minutes: 10080, resets_at: NOW + 4 * 86400 },
        credits: { has_credits: false, unlimited: false, balance: null },
        individual_limit: null,
        spend_control_reached: null,
        plan_type: "plus",
        rate_limit_reached_type: null,
        ...extra,
      },
    },
  };
}

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

function codexHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  homes.push(home);
  const day = path.join(home, "sessions", "2026", "10", "07");
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-2026-10-07T09-14-02-${ID}.jsonl`);
  const append = (...lines: unknown[]) => fs.appendFileSync(file, lines.map((l) => JSON.stringify(l) + "\n").join(""));
  const reader = new CodexSessions({ home, clock: () => NOW });
  return { home, day, file, append, reader };
}

describe("Codex's rate limits", () => {
  it("are read from token_count events, primary as 5h and secondary as 7d", async () => {
    const c = codexHome();
    c.append(META, TURN, STARTED, NO_LIMITS, counted("2026-10-07T09:14:21.305Z", 23, 41.5));
    const reports = await c.reader.poll();
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ provider: "codex", sessionId: ID, rates: null, model: "gpt-5-codex", contextSize: 272000 });
    expect(reports[1]).toMatchObject({
      provider: "codex",
      sessionId: ID,
      paneId: null,
      at: Date.parse("2026-10-07T09:14:21.305Z") / 1000,
      model: "gpt-5-codex",
      rates: { used5h: 23, resets5h: NOW + 2 * 3600, used7d: 41.5, resets7d: NOW + 4 * 86400 },
    });
    expect(reports[1]!.contextPct).toBeCloseTo((13600 / 272000) * 100, 6);
  });

  it("are read only once, then only what is appended, and never half a line", async () => {
    const c = codexHome();
    c.append(META, TURN, counted("2026-10-07T09:14:21.305Z", 23, 41));
    expect(await c.reader.poll()).toHaveLength(1);
    expect(await c.reader.poll()).toHaveLength(0);
    const line = JSON.stringify(counted("2026-10-07T09:15:00.000Z", 24, 41));
    fs.appendFileSync(c.file, line.slice(0, 40));
    expect(await c.reader.poll()).toHaveLength(0);
    fs.appendFileSync(c.file, line.slice(40) + "\n");
    expect((await c.reader.poll()).map((r) => r.rates?.used5h)).toEqual([24]);
  });

  it("are placed by window length, whichever slot they come in", () => {
    const swapped = {
      primary: { used_percent: 41, window_minutes: 10080, resets_at: NOW + 86400 },
      secondary: { used_percent: 23, window_minutes: 300, resets_at: NOW + 3600 },
    };
    expect(codexRates(swapped, NOW)).toEqual({ used5h: 23, resets5h: NOW + 3600, used7d: 41, resets7d: NOW + 86400 });
    // Unlabelled windows keep their slots.
    const bare = { primary: { used_percent: 5, window_minutes: null, resets_at: NOW + 3600 }, secondary: null };
    expect(codexRates(bare, NOW)).toEqual({ used5h: 5, resets5h: NOW + 3600, used7d: null, resets7d: null });
  });

  it("accept the older resets_in_seconds, counted from the line's time", () => {
    const old = { primary: { used_percent: 10, window_minutes: 300, resets_in_seconds: 7140 }, secondary: { used_percent: 20, window_minutes: 10080, resets_in_seconds: 86400 } };
    expect(codexRates(old, NOW)).toEqual({ used5h: 10, resets5h: NOW + 7140, used7d: 20, resets7d: NOW + 86400 });
  });

  it("skip what cannot be placed: no resets, another limit, nothing at all", () => {
    expect(codexRates({ primary_used_percent: 10, secondary_used_percent: 3, primary_window_minutes: 300, secondary_window_minutes: 10080 }, NOW)).toBeNull();
    expect(codexRates({ limit_id: "codex_other", primary: { used_percent: 9, window_minutes: 300, resets_at: NOW + 60 } }, NOW)).toBeNull();
    expect(codexRates(null, NOW)).toBeNull();
    expect(codexRates({ primary: null, secondary: null }, NOW)).toBeNull();
  });

  it("are looked for only in recent files, and from a long file's tail", async () => {
    const c = codexHome();
    // An old session: not followed.
    const old = path.join(c.day, "rollout-2026-10-05T08-00-00-00000000-0000-4000-8000-000000000000.jsonl");
    fs.writeFileSync(old, JSON.stringify(counted("2026-10-05T08:00:00.000Z", 90, 90)) + "\n");
    fs.utimesSync(old, NOW - 3 * 86400, NOW - 3 * 86400);
    // A long current one: only its last part is read.
    const filler = JSON.stringify({ timestamp: "2026-10-07T09:00:00.000Z", type: "response_item", payload: { type: "message", content: "x".repeat(1000) } });
    c.append(META, TURN, counted("2026-10-07T09:00:00.000Z", 1, 1));
    fs.appendFileSync(c.file, (filler + "\n").repeat(400));
    c.append(counted("2026-10-07T09:19:00.000Z", 30, 42));
    const reports = await c.reader.poll();
    expect(reports.map((r) => r.rates?.used5h)).toEqual([30]);
    // Without its head, the session is named from the file.
    expect(reports[0]!.sessionId).toBe(ID);
  });

  it("reach the meters through the usage service", async () => {
    const c = codexHome();
    c.append(META, TURN, counted("2026-10-07T09:19:30.000Z", 23, 41.5));
    const svc = new UsageService({ codex: c.reader, clock: () => NOW });
    await svc.pollCodex();
    const snap = svc.refresh();
    expect(snap.providers).toEqual([
      expect.objectContaining({ provider: "codex", fiveHour: expect.objectContaining({ usedPct: 23 }), sevenDay: expect.objectContaining({ usedPct: 41.5 }), stale: false }),
    ]);
    expect(snap.agents).toEqual([expect.objectContaining({ provider: "codex", sessionId: ID, model: "gpt-5-codex", paneId: null })]);
  });
});
