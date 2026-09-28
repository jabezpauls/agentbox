import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { EditorClientMessage, EditorServerMessage } from "@workbench/shared";
import { BridgeClient, type Opener } from "../src/client.js";

/** A stand-in for the bridge's /ws/editor. */
async function fakeBridge(port = 0) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const received: EditorClientMessage[] = [];
  let peer: WebSocket | null = null;
  const connected = new Set<(ws: WebSocket) => void>();
  wss.on("connection", (ws) => {
    peer = ws;
    ws.on("message", (raw) => received.push(JSON.parse(raw.toString()) as EditorClientMessage));
    for (const c of connected) c(ws);
  });
  return {
    port: (wss.address() as AddressInfo).port,
    received,
    peer: () => peer,
    nextConnection: () => new Promise<WebSocket>((resolve) => connected.add(resolve)),
    send: (m: EditorServerMessage) => peer?.send(JSON.stringify(m)),
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }),
  };
}

async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

function client(port: number, opener: Opener, focused = true, theme?: (kind: "light" | "dark") => void) {
  const c = new BridgeClient({
    url: `ws://127.0.0.1:${port}/ws/editor`,
    version: "9.9.9",
    opener,
    focused: () => focused,
    ...(theme ? { theme } : {}),
    minDelayMs: 20,
    maxDelayMs: 100,
  });
  c.start();
  cleanup.push(() => c.stop());
  return c;
}

describe("the extension's bridge client, theme and goodbye", () => {
  it("follows the theme it is sent, and ignores one it does not know", async () => {
    const bridge = await fakeBridge();
    cleanup.push(bridge.close);
    const kinds: string[] = [];
    client(bridge.port, { open: async () => {} }, true, (k) => void kinds.push(k));
    await until(() => bridge.received.length > 0);
    bridge.send({ type: "theme", kind: "dark" });
    bridge.peer()?.send(JSON.stringify({ type: "theme", kind: "sepia" }));
    bridge.send({ type: "theme", kind: "light" });
    await until(() => kinds.length === 2);
    expect(kinds).toEqual(["dark", "light"]);
  });

  it("says goodbye when the window closes", async () => {
    const bridge = await fakeBridge();
    cleanup.push(bridge.close);
    const c = client(bridge.port, { open: async () => {} });
    await until(() => bridge.received.length > 0);
    c.stop();
    await until(() => bridge.received.some((m) => m.type === "bye"));
  });
});

describe("the extension's bridge client", () => {
  it("says hello with its version and focus", async () => {
    const bridge = await fakeBridge();
    cleanup.push(bridge.close);
    client(bridge.port, { open: async () => {} }, true);
    await until(() => bridge.received.length > 0);
    expect(bridge.received[0]).toEqual({ type: "hello", version: "9.9.9", focused: true });
  });

  it("opens what it is sent, at the line, and says it did", async () => {
    const bridge = await fakeBridge();
    cleanup.push(bridge.close);
    const opened: unknown[][] = [];
    client(bridge.port, { open: async (...args) => void opened.push(args) });
    await until(() => bridge.received.length > 0);
    bridge.send({ type: "open", id: "a1", path: "/workspace/src/main.ts", line: 12, column: 4 });
    await until(() => bridge.received.some((m) => m.type === "opened"));
    expect(opened).toEqual([["/workspace/src/main.ts", 12, 4]]);
    expect(bridge.received.at(-1)).toEqual({ type: "opened", id: "a1", ok: true });
  });

  it("says why it could not open something", async () => {
    const bridge = await fakeBridge();
    cleanup.push(bridge.close);
    client(bridge.port, {
      open: async () => {
        throw new Error("file not found");
      },
    });
    await until(() => bridge.received.length > 0);
    bridge.send({ type: "open", id: "b2", path: "/nope" });
    await until(() => bridge.received.some((m) => m.type === "opened"));
    expect(bridge.received.at(-1)).toEqual({ type: "opened", id: "b2", ok: false, error: "file not found" });
  });

  it("ignores what it does not understand", async () => {
    const bridge = await fakeBridge();
    cleanup.push(bridge.close);
    let calls = 0;
    client(bridge.port, { open: async () => void calls++ });
    await until(() => bridge.received.length > 0);
    bridge.peer()?.send("not json");
    bridge.peer()?.send(JSON.stringify({ type: "shutdown" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(0);
    expect(bridge.received).toHaveLength(1);
  });

  it("reports focus changes", async () => {
    const bridge = await fakeBridge();
    cleanup.push(bridge.close);
    const c = client(bridge.port, { open: async () => {} });
    await until(() => c.connected);
    c.focusChanged(false);
    await until(() => bridge.received.some((m) => m.type === "focus"));
    expect(bridge.received.at(-1)).toEqual({ type: "focus", focused: false });
  });

  it("reconnects when the bridge restarts, and waits for one that is not up yet", async () => {
    // Nothing listening yet: the client keeps trying.
    const probe = await fakeBridge();
    const port = probe.port;
    await probe.close();
    const c = client(port, { open: async () => {} });
    await new Promise((r) => setTimeout(r, 100));
    expect(c.connected).toBe(false);

    const first = await fakeBridge(port);
    await until(() => first.received.length > 0);
    await first.close();
    await until(() => !c.connected);

    const second = await fakeBridge(port);
    cleanup.push(second.close);
    await until(() => second.received.length > 0);
    expect(second.received[0]).toMatchObject({ type: "hello" });
  });
});
