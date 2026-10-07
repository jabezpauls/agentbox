import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UsageSnapshot } from "@workbench/shared";
import { UsageService, STALE_AFTER_S, AGENT_HORIZON_S } from "../src/usage/service.js";
import { parseClaudeStatus, type UsageReport } from "../src/usage/report.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0) / 1000;
const H = 3600;

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "usage-service-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A service whose clock the test moves. */
function service(opts: { file?: string; claudeAccountFile?: string } = {}) {
  const clock = { now: NOW };
  const usage = new UsageService({ ...opts, clock: () => clock.now });
  return { usage, clock };
}

function report(over: Partial<UsageReport> & { u5?: number; r5?: number; u7?: number; r7?: number } = {}): UsageReport {
  const { u5 = 31, r5 = NOW + 2 * H, u7 = 40, r7 = NOW + 3 * 86400, ...rest } = over;
  return {
    provider: "claude",
    sessionId: "s1",
    paneId: "w1:p1",
    at: NOW,
    model: "Opus 5.5",
    modelId: "claude-opus-5-5",
    contextPct: 35,
    contextSize: 1_000_000,
    rates: { used5h: u5, resets5h: r5, used7d: u7, resets7d: r7 },
    activity: "1",
    ...rest,
  };
}

describe("the usage service", () => {
  it("starts empty", () => {
    const { usage } = service();
    expect(usage.refresh()).toEqual({ providers: [], agents: [], computedAt: NOW });
  });

  it("turns a report into the account's windows and the session's context", () => {
    const { usage } = service();
    usage.ingest(report());
    const snap = usage.refresh();
    expect(snap.providers).toEqual([
      {
        provider: "claude",
        // Three hours into the 5-hour window: a projection, and its severity.
        fiveHour: { usedPct: 31, resetsAt: NOW + 2 * H, projectedPct: expect.any(Number), etaSeconds: null, severity: expect.any(String) },
        sevenDay: { usedPct: 40, resetsAt: NOW + 3 * 86400, projectedPct: expect.any(Number), etaSeconds: null, severity: expect.any(String) },
        observedAt: NOW,
        stale: false,
        limited: false,
      },
    ]);
    expect(snap.agents).toEqual([
      { paneId: "w1:p1", sessionId: "s1", provider: "claude", model: "Opus 5.5", contextPct: 35, contextSize: 1_000_000, contextSeverity: "ok", observedAt: NOW },
    ]);
  });

  it("reads a real status line sample", () => {
    const sample = JSON.parse(fs.readFileSync(path.join(here, "fixtures/claude-status.json"), "utf8"));
    const r = parseClaudeStatus(sample, "w2:p3", 1791396000);
    expect(r).toMatchObject({
      provider: "claude",
      sessionId: "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f",
      paneId: "w2:p3",
      model: "Opus 5.5",
      modelId: "claude-opus-5-5",
      contextPct: 35,
      contextSize: 1_000_000,
      rates: { used5h: 31, resets5h: 1791402600, used7d: 40, resets7d: 1791442800 },
    });
    expect(parseClaudeStatus({ ...sample, rate_limits: undefined }, null, 1)?.rates).toBeNull();
    for (const junk of [null, 1, "x", [], {}, { session_id: 7 }, { session_id: "../../x y" }]) {
      expect(parseClaudeStatus(junk, null, 1)).toBeNull();
    }
  });

  it("marks the numbers stale when no live reading has come for ten minutes", () => {
    const { usage, clock } = service();
    usage.ingest(report());
    clock.now = NOW + STALE_AFTER_S;
    expect(usage.refresh().providers[0]).toMatchObject({ stale: false, observedAt: NOW });
    clock.now = NOW + STALE_AFTER_S + 1;
    expect(usage.refresh().providers[0]).toMatchObject({ stale: true, observedAt: NOW });
  });

  it("does not take an idle session's frozen replay for a live reading", () => {
    const { usage, clock } = service();
    usage.ingest(report());
    // The same numbers, the same activity, for a quarter of an hour.
    for (let t = 60; t <= 900; t += 60) usage.ingest(report({ at: NOW + t }));
    clock.now = NOW + 900;
    // Live until the frozen-blob gate closed, at ten minutes.
    expect(usage.refresh().providers[0]).toMatchObject({ observedAt: NOW + STALE_AFTER_S });
  });

  it("does take a session that is working, though its percentages have not moved", () => {
    const { usage, clock } = service();
    usage.ingest(report());
    for (let t = 60; t <= 900; t += 60) usage.ingest(report({ at: NOW + t, activity: String(t) }));
    clock.now = NOW + 900;
    expect(usage.refresh().providers[0]).toMatchObject({ observedAt: NOW + 900, stale: false });
  });

  it("says when a window is at its limit", () => {
    const { usage } = service();
    usage.ingest(report({ u5: 100 }));
    expect(usage.refresh().providers[0]).toMatchObject({ limited: true, fiveHour: { usedPct: 100, severity: "hot" } });
  });

  it("gives the near-cap ETA", () => {
    const { usage } = service();
    usage.ingest(report({ u5: 90, r5: NOW + H }));
    expect(usage.refresh().providers[0]!.fiveHour!.etaSeconds).toBe(Math.floor((10 / 22.5) * 3600));
  });

  it("shows nothing for a window whose reset has passed with no new reading", () => {
    const { usage, clock } = service();
    usage.ingest(report());
    clock.now = NOW + 2 * H + 1;
    const p = usage.refresh().providers[0]!;
    expect(p.fiveHour).toBeNull();
    expect(p.sevenDay).toMatchObject({ usedPct: 40 });
  });

  it("lists sessions newest first, for an hour", () => {
    const { usage, clock } = service();
    usage.ingest(report({ sessionId: "old", at: NOW - 10 }));
    usage.ingest(report({ sessionId: "new", paneId: null, contextPct: 90 }));
    expect(usage.refresh().agents.map((a) => [a.sessionId, a.contextSeverity])).toEqual([
      ["new", "hot"],
      ["old", "ok"],
    ]);
    clock.now = NOW - 10 + AGENT_HORIZON_S + 1;
    expect(usage.refresh().agents.map((a) => a.sessionId)).toEqual(["new"]);
  });

  it("keeps each logged-in account's numbers apart", () => {
    const dir = tmp();
    const account = path.join(dir, ".claude.json");
    const login = (uuid: string) =>
      fs.writeFileSync(account, JSON.stringify({ numStartups: 3, oauthAccount: { accountUuid: uuid, emailAddress: "x@example.com" } }) + " ".repeat(uuid.charCodeAt(0) % 7));
    const { usage } = service({ claudeAccountFile: account });
    login("aaaaaaaa-0000-4000-8000-000000000001");
    usage.ingest(report({ u5: 77 }));
    expect(usage.refresh().providers[0]!.fiveHour!.usedPct).toBe(77);
    login("bbbbbbbb-0000-4000-8000-000000000002");
    expect(usage.refresh().providers).toEqual([]);
    usage.ingest(report({ u5: 14, r5: NOW + 3 * H }));
    expect(usage.refresh().providers[0]!.fiveHour!.usedPct).toBe(14);
    login("aaaaaaaa-0000-4000-8000-000000000001");
    expect(usage.refresh().providers[0]!.fiveHour!.usedPct).toBe(77);
  });

  it("tells listeners only when something they show changed", () => {
    const { usage, clock } = service();
    const seen: UsageSnapshot[] = [];
    usage.on((s) => seen.push(s));
    usage.ingest(report());
    usage.refresh();
    expect(seen).toHaveLength(1);
    clock.now = NOW + 5;
    usage.refresh();
    expect(seen).toHaveLength(1);
    usage.ingest(report({ u5: 32, at: NOW + 5 }));
    usage.refresh();
    expect(seen).toHaveLength(2);
  });

  it("keeps its state across a restart", () => {
    const file = path.join(tmp(), "nested", "usage.json");
    const first = service({ file });
    first.usage.ingest(report());
    const before = first.usage.refresh();
    first.usage.stop();
    expect(fs.existsSync(file)).toBe(true);
    const second = service({ file });
    const after = second.usage.refresh();
    expect(after.providers[0]).toMatchObject({ fiveHour: { usedPct: 31 }, sevenDay: { usedPct: 40 }, observedAt: NOW });
    expect(after.agents).toEqual(before.agents);
  });

  it("starts afresh from a state file it cannot read", () => {
    const file = path.join(tmp(), "usage.json");
    fs.writeFileSync(file, "{not json");
    expect(service({ file }).usage.refresh().providers).toEqual([]);
  });
});
