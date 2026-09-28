import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getHealth = vi.fn();
vi.mock("../api/client.ts", () => ({ getHealth: () => getHealth() }));

const { loadHealth, resetHealth, retryDelay, useHealthState } = await import("./health.ts");
const { useApp } = await import("../store/app.ts");

const health = { ok: true, workspaceRoot: "/workspace", homeRoot: "/home/coder" };

beforeEach(() => {
  vi.useFakeTimers();
  resetHealth();
  getHealth.mockReset();
  useApp.setState({ health: null });
});
afterEach(() => vi.useRealTimers());

describe("loadHealth", () => {
  it("retries with backoff until the box answers", async () => {
    getHealth.mockRejectedValueOnce(new TypeError("fetch failed")).mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue(health);
    await loadHealth();
    expect(useHealthState.getState().error).toMatch(/could not be reached/);
    expect(useApp.getState().health).toBeNull();
    await vi.advanceTimersByTimeAsync(retryDelay(1));
    expect(getHealth).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(retryDelay(2));
    expect(getHealth).toHaveBeenCalledTimes(3);
    expect(useApp.getState().health).toEqual(health);
    expect(useHealthState.getState().error).toBeNull();
    // And then stops asking.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getHealth).toHaveBeenCalledTimes(3);
  });

  it("backs off to at most thirty seconds", () => {
    expect(retryDelay(1)).toBe(1000);
    expect(retryDelay(3)).toBe(4000);
    expect(retryDelay(20)).toBe(30_000);
  });

  it("asks now when asked, instead of waiting out the backoff", async () => {
    getHealth.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue(health);
    await loadHealth();
    await loadHealth();
    expect(useApp.getState().health).toEqual(health);
  });
});
