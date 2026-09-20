import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { request, subscribe, HerdrError } from "../src/herdr/socket.js";
import { startTestHerdr, TestHerdr } from "./helpers/herdr.js";
import { waitFor } from "./helpers/wait.js";

let h: TestHerdr;
beforeAll(async () => {
  h = await startTestHerdr();
}, 20_000);
afterAll(() => h.stop());

describe("socket", () => {
  it("answers ping", async () => {
    const r = await request<{ type: string; version: string }>(h.socketPath, "ping", {});
    expect(r.type).toBe("pong");
    expect(r.version).toMatch(/^\d+\./);
  });

  it("surfaces errors with code", async () => {
    await expect(request(h.socketPath, "pane.get", { pane_id: "nope" })).rejects.toBeInstanceOf(HerdrError);
  });

  it("streams lifecycle events after subscription_started", async () => {
    const got: string[] = [];
    const sub = await subscribe(
      h.socketPath,
      [{ type: "workspace.created" }, { type: "workspace.renamed" }],
      (e) => got.push(e.event),
      () => {},
    );
    const ws = await request<{ workspace: { workspace_id: string } }>(h.socketPath, "workspace.create", {
      cwd: h.dir,
      label: "a",
    });
    await request(h.socketPath, "workspace.rename", { workspace_id: ws.workspace.workspace_id, label: "b" });
    await waitFor(() => got.length >= 2);
    expect(got).toEqual(["workspace_created", "workspace_renamed"]);
    sub.close();
  });
});
