import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { WebSocket } from "ws";
import type { EditorClientMessage, EditorServerMessage } from "@workbench/shared";
import { EditorChannel } from "../src/editor.js";
import { filesFixture, type FilesFixture } from "./helpers/files.js";

let f: FilesFixture;
let port: number;

beforeAll(async () => {
  f = await filesFixture({}, () => ({ editor: new EditorChannel(500) }));
  await f.app.listen({ host: "127.0.0.1", port: 0 });
  port = (f.app.server.address() as AddressInfo).port;
  fs.mkdirSync(path.join(f.workspace, "src"));
  fs.writeFileSync(path.join(f.workspace, "src", "main.ts"), "export {};\n");
});

afterAll(async () => {
  await f.close();
});

/** A stand-in for the extension: says hello, then answers opens as told. */
async function fakeEditor(opts: { answer?: (m: EditorServerMessage) => EditorClientMessage | null; focused?: boolean } = {}) {
  const got: EditorServerMessage[] = [];
  const themes: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/editor`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString()) as EditorServerMessage;
    if (m.type === "theme") {
      themes.push(m.kind);
      return;
    }
    got.push(m);
    const reply = opts.answer ? opts.answer(m) : { type: "opened", id: m.id, ok: true };
    if (reply) ws.send(JSON.stringify(reply));
  });
  ws.send(JSON.stringify({ type: "hello", version: "0.1.0", focused: opts.focused ?? false } satisfies EditorClientMessage));
  // Let the hello land before the test asks for anything.
  await new Promise((r) => setTimeout(r, 50));
  const say = async (m: EditorClientMessage) => {
    ws.send(JSON.stringify(m));
    await new Promise((r) => setTimeout(r, 30));
  };
  return { ws, got, themes, say, close: () => new Promise<void>((r) => (ws.once("close", () => r()), ws.close())) };
}

/** Wait until the bridge counts `n` editors (a closed socket takes a moment to be noticed). */
async function connectedCount(n: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { connected } = (await f.app.inject({ method: "GET", url: "/api/editor/status" })).json() as { connected: number };
    if (connected === n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`never ${n} editors`);
}

const open = (payload: object) => f.app.inject({ method: "POST", url: "/api/editor/open", payload });

describe("the editor channel", () => {
  it("says so when no editor is open", async () => {
    const res = await open({ path: "src/main.ts" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ delivered: false, error: "no editor is open" });
  });

  it("delivers an open, at a line and column, to the editor", async () => {
    const ed = await fakeEditor();
    expect((await f.app.inject({ method: "GET", url: "/api/editor/status" })).json()).toEqual({ connected: 1, theme: null });
    const res = await open({ path: "src/main.ts", line: 12, column: 3 });
    expect(res.json()).toEqual({ delivered: true });
    expect(ed.got[0]).toMatchObject({ type: "open", path: path.join(f.workspace, "src", "main.ts"), line: 12, column: 3 });
    await ed.close();
  });

  it("passes on the editor's refusal, and gives up on a silent one", async () => {
    const refusing = await fakeEditor({ answer: (m) => ({ type: "opened", id: m.id, ok: false, error: "binary file" }) });
    expect((await open({ path: "src/main.ts" })).json()).toEqual({ delivered: false, error: "binary file" });
    await refusing.close();
    const silent = await fakeEditor({ answer: () => null });
    expect((await open({ path: "src/main.ts" })).json()).toEqual({ delivered: false, error: "the editor did not answer" });
    await silent.close();
  });

  it("sends to the editor focused most recently", async () => {
    const a = await fakeEditor({ focused: false });
    const b = await fakeEditor({ focused: true });
    await open({ path: "src/main.ts" });
    expect(b.got).toHaveLength(1);
    expect(a.got).toHaveLength(0);
    a.ws.send(JSON.stringify({ type: "focus", focused: true }));
    await new Promise((r) => setTimeout(r, 30));
    await open({ path: "src/main.ts" });
    expect(a.got).toHaveLength(1);
    await a.close();
    await b.close();
  });

  it("prefers a window that just connected over a closed tab's lingering one", async () => {
    // A tab that was focused, then closed: code-server keeps its window.
    const ghost = await fakeEditor({ focused: true });
    await ghost.say({ type: "focus", focused: true });
    // A new tab opens the editor; it has not been focused yet.
    const fresh = await fakeEditor({ focused: false });
    await open({ path: "src/main.ts" });
    expect(fresh.got).toHaveLength(1);
    expect(ghost.got).toHaveLength(0);
    await ghost.close();
    await fresh.close();
  });

  it("waits a moment for the app's own frame to announce itself, when fresh", async () => {
    const live = await fakeEditor();
    // Then the ghost was focused last, before its tab closed.
    const ghost = await fakeEditor();
    await ghost.say({ type: "focus", focused: true });
    // The app brings its frame forward and asks at once; the frame's focus
    // lands a moment after the request.
    const pending = open({ path: "src/main.ts", fresh: true, wait: 5000 });
    setTimeout(() => live.ws.send(JSON.stringify({ type: "focus", focused: true })), 100);
    expect((await pending).json()).toEqual({ delivered: true });
    expect(live.got).toHaveLength(1);
    expect(ghost.got).toHaveLength(0);
    await live.close();
    await ghost.close();
  });

  it("waits for the app's own window while its frame is still loading, however many others there are", async () => {
    await connectedCount(0);
    // Windows of tabs long closed, one of them focused last.
    const ghostA = await fakeEditor({ answer: () => null });
    const ghostB = await fakeEditor({ answer: () => null });
    await ghostB.say({ type: "focus", focused: true });
    const pending = open({ path: "src/main.ts", fresh: true, starting: true, wait: 5000 });
    // The app's frame takes a couple of seconds to load its window.
    await new Promise((r) => setTimeout(r, 300));
    const mine = await fakeEditor();
    expect((await pending).json()).toEqual({ delivered: true });
    expect(mine.got).toHaveLength(1);
    expect(ghostA.got).toHaveLength(0);
    expect(ghostB.got).toHaveLength(0);
    await Promise.all([ghostA.close(), ghostB.close(), mine.close()]);
  });

  it("ranks a window that let an open go unanswered below the rest, until it stirs", async () => {
    await connectedCount(0);
    let answering = false;
    const live = await fakeEditor();
    const ghost = await fakeEditor({ answer: (m) => (answering ? { type: "opened", id: (m as { id: string }).id, ok: true } : null) });
    await ghost.say({ type: "focus", focused: true });
    // The ghost was seen last, so it is asked first, and says nothing.
    expect((await open({ path: "src/main.ts" })).json()).toEqual({ delivered: false, error: "the editor did not answer" });
    // Next time the live one is asked.
    expect((await open({ path: "src/main.ts" })).json()).toEqual({ delivered: true });
    expect(live.got).toHaveLength(1);
    // Any word from the silent one — a blur will do — brings it back.
    answering = true;
    await ghost.say({ type: "focus", focused: false });
    await open({ path: "src/main.ts" });
    expect(ghost.got).toHaveLength(2);
    await Promise.all([live.close(), ghost.close()]);
  });

  it("still asks a silent window when it is the only one open", async () => {
    await connectedCount(0);
    let answering = false;
    const only = await fakeEditor({ answer: (m) => (answering ? { type: "opened", id: (m as { id: string }).id, ok: true } : null) });
    expect((await open({ path: "src/main.ts" })).json()).toEqual({ delivered: false, error: "the editor did not answer" });
    answering = true;
    expect((await open({ path: "src/main.ts" })).json()).toEqual({ delivered: true });
    await only.close();
  });

  it("stops telling windows a theme when the app turns following off", async () => {
    const set = (kind: unknown) => f.app.inject({ method: "POST", url: "/api/editor/theme", payload: { kind } });
    await set("dark");
    expect((await set(null)).statusCode).toBe(200);
    const late = await fakeEditor();
    expect(late.themes).toEqual([]);
    expect((await f.app.inject({ method: "GET", url: "/api/editor/status" })).json()).toMatchObject({ theme: null });
    await late.close();
  });

  it("drops a window that says it is closing", async () => {
    await connectedCount(0);
    const leaving = await fakeEditor({ focused: true });
    await connectedCount(1);
    await leaving.say({ type: "bye" });
    expect((await f.app.inject({ method: "GET", url: "/api/editor/status" })).json()).toMatchObject({ connected: 0 });
    expect((await open({ path: "src/main.ts" })).json()).toEqual({ delivered: false, error: "no editor is open" });
    await leaving.close();
  });

  it("tells every window the app's theme, now and as each connects", async () => {
    const early = await fakeEditor();
    const set = (kind: unknown) => f.app.inject({ method: "POST", url: "/api/editor/theme", payload: { kind } });
    expect((await set("dark")).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(early.themes).toEqual(["dark"]);
    // A window that connects later is told on hello.
    const late = await fakeEditor();
    expect(late.themes).toEqual(["dark"]);
    // A change reaches both; the same theme again is not news.
    await set("light");
    await set("light");
    await new Promise((r) => setTimeout(r, 30));
    expect(early.themes).toEqual(["dark", "light"]);
    expect(late.themes).toEqual(["dark", "light"]);
    expect((await f.app.inject({ method: "GET", url: "/api/editor/status" })).json()).toMatchObject({ theme: "light" });
    expect((await set("sepia")).statusCode).toBe(400);
    await early.close();
    await late.close();
  });

  it("waits for an editor that is still starting, when asked to", async () => {
    const pending = open({ path: "src/main.ts", wait: 3000 });
    await new Promise((r) => setTimeout(r, 200));
    const ed = await fakeEditor();
    expect((await pending).json()).toEqual({ delivered: true });
    await ed.close();
  });

  it("refuses paths outside the roots and missing files before asking", async () => {
    expect((await open({ path: "/etc/passwd" })).statusCode).toBe(403);
    expect((await open({ path: "nope.ts" })).statusCode).toBe(404);
    expect((await open({ path: "src/main.ts", line: 0 })).statusCode).toBe(400);
    expect((await open({})).statusCode).toBe(400);
  });
});

describe("who may be the editor", () => {
  const attempt = (headers: Record<string, string>) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/editor`, { headers });
      ws.once("open", () => {
        ws.close();
        resolve(101);
      });
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("error", () => resolve(-1));
    });

  it("refuses a browser, even on loopback", async () => {
    expect(await attempt({ origin: `http://127.0.0.1:${port}` })).toBe(403);
  });

  it("refuses anything that came through a proxy", async () => {
    expect(await attempt({ "x-forwarded-for": "203.0.113.9" })).toBe(403);
    expect(await attempt({ forwarded: "for=203.0.113.9" })).toBe(403);
  });

  it("accepts the extension's plain client", async () => {
    expect(await attempt({})).toBe(101);
  });
});
