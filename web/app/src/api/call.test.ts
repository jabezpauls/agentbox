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

  it("turns a rejected call into an error toast naming the method", async () => {
    rpc.mockRejectedValue(new RpcError(403, "method not allowed"));
    await expect(call("worktree.create")).resolves.toBeUndefined();

    const toasts = useApp.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.kind).toBe("error");
    expect(toasts[0]!.title).toBe("worktree.create failed");
    expect(toasts[0]!.detail).toBe("method not allowed");
  });

  it("reports a non-Error rejection rather than showing nothing", async () => {
    rpc.mockRejectedValue("herdr is not connected");
    await call("pane.close");
    expect(useApp.getState().toasts[0]!.detail).toBe("herdr is not connected");
  });

  it("stacks one toast per failure so a burst is not collapsed into silence", async () => {
    rpc.mockRejectedValue(new Error("boom"));
    await call("a");
    await call("b");
    expect(useApp.getState().toasts.map((t) => t.title)).toEqual(["a failed", "b failed"]);
  });
});
