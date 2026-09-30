import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKOFF_MAX_MS,
  MAX_ATTEMPTS,
  ReconnectPolicy,
  TerminalSocket,
  backoffDelay,
  prewarmTerminalSocket,
  resetTerminalSocketForTests,
} from "./stream.ts";

describe("the shared terminal socket", () => {
  class FakeWS {
    static made: FakeWS[] = [];
    binaryType = "";
    sent: Record<string, unknown>[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      FakeWS.made.push(this);
    }
    send(d: string) {
      this.sent.push(JSON.parse(d) as Record<string, unknown>);
    }
    open() {
      this.onopen?.();
    }
    drop() {
      this.onclose?.();
    }
    frame(ch: number, text: string) {
      const bytes = new TextEncoder().encode(text);
      const buf = new ArrayBuffer(2 + bytes.length);
      new DataView(buf).setUint16(0, ch);
      new Uint8Array(buf, 2).set(bytes);
      this.onmessage?.({ data: buf });
    }
    json(m: object) {
      this.onmessage?.({ data: JSON.stringify(m) });
    }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  const real = globalThis.WebSocket;
  beforeEach(() => {
    FakeWS.made = [];
    resetTerminalSocketForTests();
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket;
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = real;
  });

  it("is opened ahead of the first pane, and every pane attaches over it", async () => {
    prewarmTerminalSocket();
    expect(FakeWS.made).toHaveLength(1);
    const ws = FakeWS.made[0]!;
    expect(ws.url).toMatch(/\/ws\/terminal$/);
    ws.open();

    const a = new TerminalSocket("w1:p1", { cols: 90, rows: 30 });
    const b = new TerminalSocket("w1:p2", { cols: 40, rows: 10 });
    await tick();
    expect(FakeWS.made).toHaveLength(1);
    const attaches = ws.sent.filter((m) => m.type === "attach");
    expect(attaches).toEqual([
      { ch: expect.any(Number), type: "attach", pane: "w1:p1", cols: 90, rows: 30 },
      { ch: expect.any(Number), type: "attach", pane: "w1:p2", cols: 40, rows: 10 },
    ]);
    const [chA, chB] = attaches.map((m) => m.ch as number);
    expect(chA).not.toBe(chB);

    // Output goes to its own pane only.
    const gotA: string[] = [];
    const gotB: string[] = [];
    a.onData((d) => gotA.push(new TextDecoder().decode(d)));
    b.onData((d) => gotB.push(new TextDecoder().decode(d)));
    ws.frame(chA!, "hello a");
    ws.frame(chB!, "hello b");
    expect(gotA).toEqual(["hello a"]);
    expect(gotB).toEqual(["hello b"]);

    // Input is tagged with the pane's channel; closing a pane detaches it.
    a.input("ls\r");
    expect(ws.sent.at(-1)).toEqual({ ch: chA, type: "input", text: "ls\r" });
    a.close();
    expect(ws.sent.at(-1)).toEqual({ ch: chA, type: "detach" });
    b.close();
  });

  it("holds input until the socket opens, attaching first", () => {
    const t = new TerminalSocket("w2:p1", { cols: 80, rows: 24 });
    t.input("x");
    const ws = FakeWS.made[0]!;
    expect(ws.sent).toEqual([]);
    ws.open();
    expect(ws.sent.map((m) => m.type)).toEqual(["attach", "input"]);
    t.close();
  });

  it("re-attaches every pane after a drop, and reports the gap", () => {
    vi.useFakeTimers();
    const t = new TerminalSocket("w3:p1", { cols: 80, rows: 24 });
    const states: string[] = [];
    t.onState((s) => states.push(s));
    FakeWS.made[0]!.open();
    FakeWS.made[0]!.drop();
    expect(states).toEqual(["open", "reconnecting"]);
    vi.advanceTimersByTime(500);
    const again = FakeWS.made[1]!;
    again.open();
    expect(again.sent[0]).toMatchObject({ type: "attach", pane: "w3:p1" });
    expect(states.at(-1)).toBe("open");
    t.close();
  });

  it("tells a pane that has gone, and leaves the others be", async () => {
    const a = new TerminalSocket("w4:p1", { cols: 80, rows: 24 });
    const b = new TerminalSocket("w4:p2", { cols: 80, rows: 24 });
    const ws = FakeWS.made[0]!;
    ws.open();
    const chA = ws.sent[0]!.ch as number;
    let gone = "";
    const statesB: string[] = [];
    a.onGone((r) => (gone = r));
    b.onState((s) => statesB.push(s));
    ws.json({ ch: chA, type: "closed", reason: "pane exited" });
    expect(gone).toBe("pane exited");
    expect(statesB).toEqual([]);
    b.close();
  });
});

describe("backoffDelay", () => {
  it("doubles from the base on each successive attempt", () => {
    expect(backoffDelay(1)).toBe(500);
    expect(backoffDelay(2)).toBe(1000);
    expect(backoffDelay(3)).toBe(2000);
    expect(backoffDelay(4)).toBe(4000);
  });

  it("caps the delay so a long outage still retries at a steady beat", () => {
    expect(backoffDelay(20)).toBe(BACKOFF_MAX_MS);
  });

  it("treats a zeroth attempt as the first rather than halving the base", () => {
    expect(backoffDelay(0)).toBe(500);
  });
});

describe("ReconnectPolicy", () => {
  it("hands out increasing delays while it keeps failing", () => {
    const p = new ReconnectPolicy();
    expect(p.next()).toBe(500);
    expect(p.next()).toBe(1000);
    expect(p.next()).toBe(2000);
  });

  it("gives up after the attempt budget so the cell can offer a manual retry", () => {
    const p = new ReconnectPolicy();
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect(p.next()).not.toBeNull();
    expect(p.next()).toBeNull();
  });

  it("starts over after a successful open, so a later blip retries quickly", () => {
    const p = new ReconnectPolicy();
    p.next();
    p.next();
    p.reset();
    expect(p.next()).toBe(500);
  });

  it("recovers its full budget after a reset", () => {
    const p = new ReconnectPolicy();
    for (let i = 0; i <= MAX_ATTEMPTS; i++) p.next();
    expect(p.next()).toBeNull();
    p.reset();
    expect(p.next()).toBe(500);
  });
});
