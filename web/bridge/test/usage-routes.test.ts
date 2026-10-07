import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import type { EventsMessage, UsageSnapshot } from "@workbench/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { SessionHub } from "../src/herdr/session.js";
import { UsageService } from "../src/usage/service.js";
import { waitFor } from "./helpers/wait.js";

// The report route and the events socket, against a real server; and the
// status line helper the image installs, run as Claude Code runs it.

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "../../../images/workspace/agentbox-status");

const stubHub = {
  connected: true,
  version: null,
  protocol: null,
  snapshot: async () => ({}),
  on: () => () => {},
  start: async () => {},
  stop: () => {},
} as unknown as SessionHub;

let app: FastifyInstance;
let usage: UsageService;
let base: string;
let home: string;

/** The fixture, as a session would report it now: its resets moved to the present. */
function sample(sessionId = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f"): Record<string, unknown> {
  const s = JSON.parse(fs.readFileSync(path.join(here, "fixtures/claude-status.json"), "utf8"));
  const now = Math.floor(Date.now() / 1000);
  s.session_id = sessionId;
  s.rate_limits.five_hour.resets_at = now + 2 * 3600;
  s.rate_limits.seven_day.resets_at = now + 3 * 86400;
  return s;
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-routes-"));
  usage = new UsageService();
  const config = loadConfig({ WORKBENCH_PORT: "0", WORKBENCH_STATIC_DIR: "/does/not/exist", HOME: home });
  app = await buildApp(config, { hub: stubHub, usage });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  base = `127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  usage.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

const post = (payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/api/usage/report", payload: payload as object, headers });

describe("the report route", () => {
  it("takes a status line sample from inside the sandbox", async () => {
    const res = await post({ status: sample("route-ok"), paneId: "w1:p2", at: Date.now() / 1000 });
    expect(res.statusCode).toBe(204);
    const snap = (await app.inject({ method: "GET", url: "/api/usage" })).json<UsageSnapshot>();
    expect(snap.providers[0]).toMatchObject({ provider: "claude", fiveHour: { usedPct: 31 }, sevenDay: { usedPct: 40 }, stale: false });
    expect(snap.agents.find((a) => a.sessionId === "route-ok")).toMatchObject({ paneId: "w1:p2", model: "Opus 5.5", contextPct: 35 });
  });

  it("refuses what is not a status line", async () => {
    for (const body of [{}, { status: "x" }, { status: {} }, { status: { session_id: 3 } }, { stat: sample() }]) {
      expect((await post(body)).statusCode, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    const raw = await app.inject({ method: "POST", url: "/api/usage/report", payload: "{oops", headers: { "content-type": "application/json" } });
    expect(raw.statusCode).toBe(400);
  });

  it("ignores a pane id that is not one", async () => {
    await post({ status: sample("odd-pane"), paneId: "w1 p2; rm -rf /" });
    await post({ status: sample("odd-pane") });
    const snap = (await app.inject({ method: "GET", url: "/api/usage" })).json<UsageSnapshot>();
    expect(snap.agents.find((a) => a.sessionId === "odd-pane")?.paneId).toBeNull();
  });

  it("refuses a browser, or anything through a proxy", async () => {
    for (const headers of [{ origin: "https://box.example" }, { "x-forwarded-for": "203.0.113.9" }, { forwarded: "for=203.0.113.9" }, { "x-real-ip": "203.0.113.9" }]) {
      expect((await post({ status: sample("refused") }, headers)).statusCode).toBe(403);
    }
    expect(usage.refresh().agents.some((a) => a.sessionId === "refused")).toBe(false);
  });

  it("is not cached", async () => {
    expect((await app.inject({ method: "GET", url: "/api/usage" })).headers["cache-control"]).toBe("no-store");
  });
});

describe("the events socket", () => {
  it("sends the meters on connect and again after a report", async () => {
    const ws = new WebSocket(`ws://${base}/ws/events`, { origin: `http://${base}` });
    const got: EventsMessage[] = [];
    ws.on("message", (raw) => got.push(JSON.parse(raw.toString()) as EventsMessage));
    await waitFor(() => got.some((m) => m.kind === "usage"));
    const first = got.find((m) => m.kind === "usage");
    expect(first).toMatchObject({ kind: "usage", usage: { providers: expect.any(Array), agents: expect.any(Array), computedAt: expect.any(Number) } });

    await post({ status: sample("pushed"), paneId: "w9:p9" });
    await waitFor(() => got.some((m) => m.kind === "usage" && m.usage.agents.some((a) => a.sessionId === "pushed")));
    ws.close();
  });
});

describe("agentbox-status", () => {
  function run(input: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; ms: number }> {
    const started = Date.now();
    return new Promise((resolve) => {
      const child = execFile(
        "node",
        [CLI],
        { env: { PATH: process.env.PATH ?? "", HOME: home, AGENTBOX_STATUS_URL: `http://${base}`, ...env } },
        (err, stdout) => resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) : 0, stdout, ms: Date.now() - started }),
      );
      child.stdin!.end(input);
    });
  }

  it("reports to the bridge with its pane, and prints a status line", async () => {
    const res = await run(JSON.stringify(sample("from-cli")), { HERDR_PANE_ID: "w3:p4" });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("Opus 5.5 · ctx 35% · 5h 31% · 7d 40%\n");
    expect(usage.refresh().agents.find((a) => a.sessionId === "from-cli")).toMatchObject({ paneId: "w3:p4", provider: "claude" });
  });

  it("runs the person's own status line with the same input, in place of its own", async () => {
    fs.mkdirSync(path.join(home, ".agentbox"), { recursive: true });
    const chain = path.join(home, ".agentbox", "statusline-chain.json");
    fs.writeFileSync(chain, JSON.stringify({ command: "printf 'theirs:'; wc -c" }));
    const input = JSON.stringify(sample("chained"));
    try {
      const res = await run(input);
      expect(res.stdout.replace(/\s+/g, "")).toBe(`theirs:${Buffer.byteLength(input)}`);
      // A chained line that prints nothing, or fails, gives way to ours.
      fs.writeFileSync(chain, JSON.stringify({ command: "exit 3" }));
      expect((await run(input)).stdout).toMatch(/^Opus 5\.5 · /);
    } finally {
      fs.rmSync(chain);
    }
    expect(usage.refresh().agents.some((a) => a.sessionId === "chained")).toBe(true);
  });

  it("never fails the status line: junk in, or no bridge", async () => {
    expect(await run("not json")).toMatchObject({ code: 0, stdout: "agentbox\n" });
    const down = await run(JSON.stringify(sample("nobody")), { AGENTBOX_STATUS_URL: "http://127.0.0.1:9" });
    expect(down).toMatchObject({ code: 0, stdout: "Opus 5.5 · ctx 35% · 5h 31% · 7d 40%\n" });
    expect(down.ms).toBeLessThan(3000);
  });
});
