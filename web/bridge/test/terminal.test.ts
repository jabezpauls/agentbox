import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TerminalStreams, type Viewer } from "../src/herdr/terminal.js";
import { request } from "../src/herdr/socket.js";
import { startTestHerdr, TestHerdr } from "./helpers/herdr.js";
import { waitFor } from "./helpers/wait.js";
import type { TerminalServerMessage } from "@workbench/shared";

let h: TestHerdr;
let streams: TerminalStreams;
let pane: string;

interface Recorder {
  viewer: Viewer;
  frames: Buffer[];
  json: TerminalServerMessage[];
  closed: string | null;
  text(): string;
}

function recorder(): Recorder {
  const rec: Recorder = {
    frames: [],
    json: [],
    closed: null,
    text: () => Buffer.concat(rec.frames).toString("utf8"),
    viewer: {
      send: (data) => rec.frames.push(Buffer.from(data)),
      sendJson: (m) => rec.json.push(m),
      close: (reason) => {
        rec.closed = reason;
      },
    },
  };
  return rec;
}

beforeAll(async () => {
  h = await startTestHerdr();
  const created = await request<{ root_pane: { pane_id: string } }>(h.socketPath, "workspace.create", {
    cwd: h.dir,
    label: "term",
  });
  pane = created.root_pane.pane_id;
  streams = new TerminalStreams(h.env);
}, 20_000);

afterAll(async () => {
  streams.stop();
  await h.stop();
});

describe("TerminalStreams", () => {
  it("streams the pane to one viewer and echoes typed input", async () => {
    const v1 = recorder();
    const a1 = streams.attach(pane, v1.viewer, 80, 24);

    await waitFor(() => v1.frames.length >= 1, 2_000);

    a1.input("echo WB_$((6*7))\n");
    await waitFor(() => v1.text().includes("WB_42"), 5_000);
    expect(v1.text()).toContain("WB_42");

    a1.detach();
  });

  it("replays the full screen to a late-joining second viewer", async () => {
    const v1 = recorder();
    const a1 = streams.attach(pane, v1.viewer, 80, 24);
    await waitFor(() => v1.frames.length >= 1, 2_000);

    a1.input("echo WB_LATE_$((3*3))\n");
    await waitFor(() => v1.text().includes("WB_LATE_9"), 5_000);

    const v2 = recorder();
    const a2 = streams.attach(pane, v2.viewer, 80, 24);
    // A second viewer must be handed the current screen, which still shows the
    // most recent command output.
    await waitFor(() => v2.text().includes("WB_LATE_9"), 3_000);
    expect(v2.frames.length).toBeGreaterThan(0);
    expect(streams.lastFullSeq(pane)).toBeGreaterThan(0);

    a1.detach();
    a2.detach();
  });

  it("lets a viewer resize and take size ownership on focus", async () => {
    const v1 = recorder();
    const a1 = streams.attach(pane, v1.viewer, 80, 24);
    await waitFor(() => v1.frames.length >= 1, 2_000);

    const v2 = recorder();
    const a2 = streams.attach(pane, v2.viewer, 80, 24);
    await waitFor(() => v2.frames.length >= 1, 3_000);

    const v1Before = v1.frames.length;
    const v2Before = v2.frames.length;

    a2.resize(100, 30);
    a2.focus();

    await waitFor(() => v1.frames.length > v1Before && v2.frames.length > v2Before, 3_000);
    expect(streams.size(pane)).toEqual({ cols: 100, rows: 30 });
    expect(v2.json.some((m) => m.type === "size" && m.cols === 100 && m.rows === 30)).toBe(true);

    a1.detach();
    a2.detach();
  });

  it("releases the controller when the last viewer detaches", async () => {
    const v1 = recorder();
    const a1 = streams.attach(pane, v1.viewer, 80, 24);
    await waitFor(() => v1.frames.length >= 1, 2_000);
    expect(streams.active(pane)).toBe(true);

    a1.detach();
    await waitFor(() => streams.active(pane) === false, 2_000);
    expect(streams.active(pane)).toBe(false);
  });
});
