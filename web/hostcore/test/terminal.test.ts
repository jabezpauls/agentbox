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

async function newPane(label: string): Promise<string> {
  const created = await request<{ root_pane: { pane_id: string } }>(h.socketPath, "workspace.create", {
    cwd: h.dir,
    label,
  });
  return created.root_pane.pane_id;
}

beforeAll(async () => {
  h = await startTestHerdr();
  pane = await newPane("term");
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

  it("scrolls herdr's scrollback, reports where it stands, and returns to live", async () => {
    const p = await newPane("scroll");
    const v = recorder();
    const a = streams.attach(p, v.viewer, 80, 24);
    await waitFor(() => v.frames.length >= 1, 2_000);
    // herdr reports scroll positions once the pane's shell is up; output
    // printed before that never raises the event.
    await new Promise((r) => setTimeout(r, 800));
    a.input("for i in $(seq 1 500); do [ $i -le 400 ] && echo early-$i || echo late-$i; done\n");
    const last = () => v.json.filter((m) => m.type === "scrolled").at(-1);
    await waitFor(() => (last()?.max ?? 0) > 400, 5_000);

    // The wheel: the frames herdr sends now show earlier lines.
    v.frames.length = 0;
    a.scroll("up", 150);
    await waitFor(() => last()?.offset === 150, 3_000);
    await waitFor(() => /early-3\d\d/.test(v.text()), 3_000);

    a.scrollTo(0);
    await waitFor(() => last()?.offset === 0, 3_000);

    // Typing snaps a scrolled pane back to live.
    a.scroll("up", 10);
    await waitFor(() => last()?.offset === 10, 3_000);
    a.input(" ");
    await waitFor(() => last()?.offset === 0, 3_000);

    // A late viewer learns the position at once.
    const v2 = recorder();
    const a2 = streams.attach(p, v2.viewer, 80, 24);
    expect(v2.json.some((m) => m.type === "scrolled")).toBe(true);
    a2.detach();
    a.detach();
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

  it("keeps a re-attached stream alive across a stale double detach", async () => {
    const va = recorder();
    const a = streams.attach(pane, va.viewer, 80, 24);
    await waitFor(() => va.frames.length >= 1, 2_000);

    a.detach();
    await waitFor(() => streams.active(pane) === false, 2_000);

    // A new viewer B attaches and gets a fresh stream.
    const vb = recorder();
    const b = streams.attach(pane, vb.viewer, 80, 24);
    await waitFor(() => vb.frames.length >= 1, 2_000);
    expect(streams.active(pane)).toBe(true);
    expect(streams.streamCount()).toBe(1);

    // A stale second detach from A must not tear down B's stream.
    a.detach();
    expect(streams.active(pane)).toBe(true);
    expect(streams.streamCount()).toBe(1);

    // B's stream is still live: input still echoes to B.
    const before = vb.frames.length;
    b.input("echo WB_STALE_$((2*3))\n");
    await waitFor(() => vb.text().includes("WB_STALE_6"), 5_000);
    expect(vb.frames.length).toBeGreaterThan(before);

    b.detach();
    await waitFor(() => streams.active(pane) === false, 2_000);
  });

  it("drops a dead stream so a later attach spawns a fresh one", async () => {
    const p1 = await newPane("dead1");
    const v = recorder();
    streams.attach(p1, v.viewer, 80, 24);
    await waitFor(() => v.frames.length >= 1, 2_000);
    expect(streams.active(p1)).toBe(true);

    // Killing the pane makes herdr emit terminal.closed to the controller.
    await request(h.socketPath, "pane.close", { pane_id: p1 });
    await waitFor(() => v.closed !== null, 3_000);
    // The dead stream is dropped immediately, before any reuse can occur.
    expect(streams.active(p1)).toBe(false);

    // A fresh pane attaches cleanly afterward.
    const p2 = await newPane("dead2");
    const v2 = recorder();
    const a2 = streams.attach(p2, v2.viewer, 80, 24);
    await waitFor(() => v2.frames.length >= 1, 2_000);
    expect(streams.active(p2)).toBe(true);

    a2.detach();
    await waitFor(() => streams.active(p2) === false, 2_000);
  });
});
