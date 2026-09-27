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
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/editor`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString()) as EditorServerMessage;
    got.push(m);
    const reply = opts.answer ? opts.answer(m) : { type: "opened", id: m.id, ok: true };
    if (reply) ws.send(JSON.stringify(reply));
  });
  ws.send(JSON.stringify({ type: "hello", version: "0.1.0", focused: opts.focused ?? false } satisfies EditorClientMessage));
  // Let the hello land before the test asks for anything.
  await new Promise((r) => setTimeout(r, 50));
  return { ws, got, close: () => new Promise<void>((r) => (ws.once("close", () => r()), ws.close())) };
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
    expect((await f.app.inject({ method: "GET", url: "/api/editor/status" })).json()).toEqual({ connected: 1 });
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
