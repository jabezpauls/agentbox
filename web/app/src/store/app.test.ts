import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshot, UsageSnapshot } from "@workbench/shared";

import { rpc, RpcError } from "../api/client.ts";
import { resetUsageAlerts, useApp } from "./app.ts";
import { fromSnapshot } from "./session.ts";
import snapshotFixture from "./fixtures/snapshot.json" with { type: "json" };
import usageFixture from "./fixtures/usage.json" with { type: "json" };

const herdrNow = snapshotFixture as unknown as SessionSnapshot;

// What the page last heard: herdr's session plus a workspace (wB, as herdr
// names its eleventh) that herdr has since dropped without saying so.
function staleSession(): SessionSnapshot {
  const s = structuredClone(herdrNow);
  const pane = { ...s.panes[0]!, pane_id: "wB:p1", tab_id: "wB:t1", workspace_id: "wB" };
  s.workspaces.push({ ...s.workspaces[0]!, workspace_id: "wB", label: "ASE", active_tab_id: "wB:t1", focused: false });
  s.tabs.push({ ...s.tabs[0]!, tab_id: "wB:t1", workspace_id: "wB", focused: false });
  s.panes.push(pane);
  return s;
}

let sessionFetches = 0;

beforeEach(() => {
  vi.useFakeTimers();
  sessionFetches = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/session") {
        sessionFetches++;
        return new Response(JSON.stringify(herdrNow), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }),
  );
  useApp.setState({ session: fromSnapshot(staleSession()), toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const workspaceIds = () => useApp.getState().session.workspaces.map((w) => w.workspace_id);

describe("keeping up with herdr when it removes without saying", () => {
  it("takes a fresh snapshot after a pane exits, so its tab and workspace go too", async () => {
    expect(workspaceIds()).toContain("wB");
    useApp.getState().applyMessage({ kind: "event", event: "pane_exited", data: { pane_id: "wB:p1", workspace_id: "wB" } });
    // The pane goes at once; its tab and workspace only with herdr's word.
    expect(useApp.getState().session.panes["wB:p1"]).toBeUndefined();
    expect(workspaceIds()).toContain("wB");
    await vi.advanceTimersByTimeAsync(200);
    expect(sessionFetches).toBe(1);
    expect(workspaceIds()).not.toContain("wB");
    expect(useApp.getState().session.tabs.map((t) => t.tab_id)).not.toContain("wB:t1");
  });

  it("asks once for a burst of exits", async () => {
    for (const id of ["wB:p1", "w1:p1"]) {
      useApp.getState().applyMessage({ kind: "event", event: "pane_exited", data: { pane_id: id, workspace_id: id.split(":")[0]! } });
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(sessionFetches).toBe(1);
  });

  it("catches up instead of showing an error when herdr says the thing is gone", async () => {
    useApp.getState().reportRpcError("tab.focus", new RpcError(502, "tab wB:t1 not found", "tab_not_found"), () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(useApp.getState().toasts).toEqual([]);
    expect(sessionFetches).toBe(1);
    expect(workspaceIds()).not.toContain("wB");
  });

  it("still reports any other refusal", () => {
    useApp.getState().reportRpcError("tab.create", new RpcError(502, "new tab should produce a complete create response", "tab_create_failed"));
    expect(useApp.getState().toasts).toHaveLength(1);
    expect(sessionFetches).toBe(0);
  });
});

describe("rpc", () => {
  it("turns herdr's {code, message} refusal into a sentence, not [object Object]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "tab_not_found", message: "tab wB:t1 not found" } }), { status: 502 })),
    );
    const err = await rpc("tab.focus", { tab_id: "wB:t1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).message).toBe("tab wB:t1 not found");
    expect((err as RpcError).code).toBe("tab_not_found");
  });

  it("keeps the bridge's own sentence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "method not allowed: server.stop" }), { status: 403 })));
    const err = (await rpc("server.stop").catch((e: unknown) => e)) as RpcError;
    expect(err.message).toBe("method not allowed: server.stop");
    expect(err.code).toBeUndefined();
  });
});

describe("usage", () => {
  const usage = usageFixture as unknown as UsageSnapshot;
  const limited = (): UsageSnapshot => {
    const u = structuredClone(usage);
    Object.assign(u.providers[0]!, { limited: true });
    u.providers[0]!.fiveHour!.usedPct = 100;
    return u;
  };

  beforeEach(() => {
    vi.setSystemTime(usage.computedAt * 1000);
    resetUsageAlerts();
    useApp.setState({ usage: null });
  });

  it("keeps the snapshot the socket sends", () => {
    useApp.getState().applyMessage({ kind: "usage", usage });
    expect(useApp.getState().usage).toEqual(usage);
  });

  it("never lets an older snapshot (a slow REST seed) replace a newer one", () => {
    useApp.getState().applyUsage(usage);
    const older = { ...structuredClone(usage), computedAt: usage.computedAt - 60, agents: [] };
    useApp.getState().applyUsage(older);
    expect(useApp.getState().usage?.agents).toHaveLength(usage.agents.length);
  });

  it("ignores a shape it does not know", () => {
    useApp.getState().applyMessage({ kind: "usage", usage: {} as UsageSnapshot });
    expect(useApp.getState().usage).toBeNull();
  });

  it("toasts a reached limit once, however often the bridge repeats it", () => {
    for (let i = 0; i < 3; i++) {
      useApp.getState().applyMessage({ kind: "usage", usage: { ...limited(), computedAt: usage.computedAt + i * 30 } });
    }
    const toasts = useApp.getState().toasts.filter((t) => t.kind === "limit");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.title).toContain("Claude's 5-hour limit is reached");
  });
});
