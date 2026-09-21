import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./client.ts", async () => {
  const actual = await vi.importActual<typeof import("./client.ts")>("./client.ts");
  return { ...actual, rpc };
});

import { RpcError } from "./client.ts";
import { call } from "./call.ts";
import { useApp } from "../store/app.ts";

beforeEach(() => {
  rpc.mockReset();
  useApp.setState({ toasts: [] });
});

describe("call", () => {
  it("returns the result and raises nothing when the call succeeds", async () => {
    rpc.mockResolvedValue({ ok: true });
    await expect(call("pane.split", { direction: "right" })).resolves.toEqual({ ok: true });
    expect(useApp.getState().toasts).toHaveLength(0);
  });

  it("turns a rejected call into a human error toast carrying the server's message", async () => {
    rpc.mockRejectedValue(new RpcError(403, "method not allowed"));
    await expect(call("worktree.create")).resolves.toBeUndefined();

    const toasts = useApp.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.kind).toBe("error");
    expect(toasts[0]!.title).toBe("Couldn't create the worktree.");
    expect(toasts[0]!.detail).toBe("method not allowed");
  });

  it("reports a non-Error rejection rather than showing nothing", async () => {
    rpc.mockRejectedValue("herdr is not connected");
    await call("pane.close");
    expect(useApp.getState().toasts[0]!.detail).toBe("herdr is not connected");
  });

  it("stacks one toast per failure so a burst is not collapsed into silence", async () => {
    rpc.mockRejectedValue(new Error("boom"));
    await call("pane.close");
    await call("tab.close");
    expect(useApp.getState().toasts.map((t) => t.title)).toEqual([
      "Couldn't close the pane.",
      "Couldn't close the tab.",
    ]);
  });
});

describe("toast de-duplication", () => {
  it("refreshes the same failure in place instead of stacking copies of it", async () => {
    rpc.mockRejectedValue(new RpcError(500, "herdr said no"));
    await call("pane.close");
    await call("pane.close");
    const toasts = useApp.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.title).toBe("Couldn't close the pane.");
  });
});
