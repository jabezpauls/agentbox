import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SessionHub } from "../src/herdr/session.js";
import { request } from "../src/herdr/socket.js";
import { startTestHerdr, TestHerdr } from "./helpers/herdr.js";
import { waitFor } from "./helpers/wait.js";
import type { EventsMessage } from "@workbench/shared";

let h: TestHerdr;
let hub: SessionHub;

beforeAll(async () => {
  h = await startTestHerdr();
  hub = new SessionHub(h.socketPath);
  await hub.start();
}, 20_000);

afterAll(async () => {
  hub.stop();
  await h.stop();
});

describe("SessionHub", () => {
  it("connects on start", () => {
    expect(hub.connected).toBe(true);
    expect(hub.version).toMatch(/^\d+\./);
    expect(typeof hub.protocol).toBe("number");
  });

  it("forwards lifecycle events and tracks pane ids across a split", async () => {
    const events: EventsMessage[] = [];
    const off = hub.on((m) => events.push(m));

    const created = await request<{ root_pane: { pane_id: string } }>(h.socketPath, "workspace.create", {
      cwd: h.dir,
      label: "a",
    });
    const firstPane = created.root_pane.pane_id;

    await waitFor(() =>
      events.some((m) => m.kind === "event" && m.event === "workspace_created"),
    );

    await request(h.socketPath, "pane.split", { direction: "right", target_pane_id: firstPane });

    await waitFor(() => hub.paneIds().length >= 2, 8_000);
    const panes = hub.paneIds();
    expect(panes).toContain(firstPane);
    expect(panes.length).toBe(2);

    off();
  });

  it("returns a snapshot with the created workspace", async () => {
    const snap = await hub.snapshot();
    expect(snap.workspaces.length).toBe(1);
  });
});
