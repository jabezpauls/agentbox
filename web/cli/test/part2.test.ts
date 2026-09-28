import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { parseExpiry } from "../src/commands/apps.js";
import { EXIT } from "../src/errors.js";
import { withFileLock } from "../src/lock.js";
import { DetachFilter } from "../src/terminal.js";
import { capture, json, runCli, signedIn, stubServer, TOKEN, tmpDir, type Stub } from "./helpers.js";

const APP = {
  id: "abcdefghijklmnopqrstuvwxyz",
  name: "goofy",
  port: 5173,
  keepPrefix: false,
  pinned: false,
  createdBy: "agent",
  createdAt: 1,
  compat: "auto",
  visibility: { mode: "private", expiresAt: null },
  url: "/a/abcdefghijklmnopqrstuvwxyz/",
  live: { listening: true, pid: 1, process: "node", cwd: "/workspace/goofy", paneId: null, tabId: null, workspaceId: null },
};

/** A box with the apps, agents and review APIs, and a herdr tunnel that answers every request. */
async function partTwoBox(): Promise<Stub & { visibility: unknown[] }> {
  const visibility: unknown[] = [];
  const stub = (await stubServer((req, res, body) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, {});
    const url = req.url ?? "";
    if (url === "/_gate/version") return json(res, 200, { version: "0.0.0-dev" });
    if (url === "/api/apps") return json(res, 200, [APP, { ...APP, id: "bbbbbbbbbbbbbbbbbbbbbbbbbb", name: "twin" }, { ...APP, id: "cccccccccccccccccccccccccc", name: "twin" }]);
    if (url === `/_gate/apps/${APP.id}/visibility`) {
      const b = body.length ? (JSON.parse(body.toString()) as Record<string, unknown>) : {};
      visibility.push({ method: req.method, ...b });
      if (req.method === "DELETE") return json(res, 200, APP);
      return json(res, 200, { ...APP, visibility: { mode: b.mode, expiresAt: b.expiresIn === null ? null : 2e12 }, ...(b.mode === "passcode" && !b.passcode ? { passcode: "generated-pass" } : {}) });
    }
    if (url === "/api/session") {
      return json(res, 200, { workspaces: [{ workspace_id: "w1", label: "demo" }], agents: [{ pane_id: "p1", workspace_id: "w1", agent_status: "blocked", agent: "claude", cwd: "/workspace/demo" }] });
    }
    if (url === "/api/review/sessions") return json(res, 200, [{ key: "k1", label: "Plan", file: "/x", created: "c", updated: "u", status: "open", pending: 2 }]);
    json(res, 404, {});
  })) as Stub & { visibility: unknown[] };
  // herdr through the tunnel: every request line answered with its method echoed.
  const wss = new WebSocketServer({ noServer: true });
  stub.server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/_gate/tunnel?target=herdr") || req.headers.authorization !== `Bearer ${TOKEN}`) return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (d: Buffer) => {
        for (const line of d.toString().split("\n").filter(Boolean)) {
          const r = JSON.parse(line) as { id: string; method: string; params: unknown };
          const answer = r.method === "boom" ? { id: r.id, error: { code: "bad", message: "no such method" } } : { id: r.id, result: { method: r.method, params: r.params } };
          ws.send(Buffer.from(`${JSON.stringify(answer)}\n`), { binary: true });
        }
      });
    });
  });
  return Object.assign(stub, { visibility });
}

const boxes: Stub[] = [];
afterEach(async () => {
  while (boxes.length) await boxes.pop()?.close();
});
async function box(): Promise<{ stub: Stub & { visibility: unknown[] }; cfg: string }> {
  const stub = await partTwoBox();
  boxes.push(stub);
  return { stub, cfg: signedIn(stub.url) };
}

describe("apps", () => {
  it("lists apps with their absolute URLs", async () => {
    const { stub, cfg } = await box();
    const r = await runCli(["apps", "ls"], { configDir: cfg });
    expect(r.stdout).toMatch(new RegExp(`goofy\\s+${APP.id}\\s+5173\\s+up\\s+private\\s+${stub.url}/a/${APP.id}/`));
    const j = JSON.parse((await runCli(["apps", "ls", "--json"], { configDir: cfg })).stdout) as Array<{ url: string }>;
    expect(j[0]?.url).toBe(`${stub.url}/a/${APP.id}/`);
  });

  it("shares by name, with an expiry or a passcode, and unshares", async () => {
    const { stub, cfg } = await box();
    const link = await runCli(["apps", "share", "goofy", "--expires", "12h"], { configDir: cfg });
    expect(link.code, link.stderr).toBe(0);
    expect(link.stdout).toBe(`${stub.url}/a/${APP.id}/\n`);
    const pass = await runCli(["apps", "share", APP.id, "--passcode", "--expires", "never"], { configDir: cfg });
    expect(pass.stdout).toContain("passcode  generated-pass");
    await runCli(["apps", "share", "goofy", "--set-passcode", "my-own-pass"], { configDir: cfg });
    expect((await runCli(["apps", "unshare", "goofy"], { configDir: cfg })).code).toBe(0);
    expect(stub.visibility).toEqual([
      { method: "PUT", mode: "link", expiresIn: 43200 },
      { method: "PUT", mode: "passcode", expiresIn: null },
      { method: "PUT", mode: "passcode", passcode: "my-own-pass" },
      { method: "DELETE" },
    ]);
  });

  it("asks for an id when two apps share a name, and says when there is none", async () => {
    const { cfg } = await box();
    expect((await runCli(["apps", "open", "twin", "--print"], { configDir: cfg })).stderr).toMatch(/2 apps are called "twin"/);
    expect((await runCli(["apps", "open", "nope"], { configDir: cfg })).code).toBe(EXIT.NOT_FOUND);
    expect(() => parseExpiry("soon")).toThrow(/not an expiry/);
    expect(parseExpiry("7d")).toBe(604800);
  });
});

describe("agents and review", () => {
  it("lists agents and reviews, and opens a review", async () => {
    const { stub, cfg } = await box();
    expect((await runCli(["agents", "ls"], { configDir: cfg })).stdout).toMatch(/claude\s+blocked\s+demo\s+p1\s+\/workspace\/demo/);
    expect((await runCli(["review", "ls"], { configDir: cfg })).stdout).toMatch(/k1\s+open\s+2\s+u\s+Plan/);
    expect((await runCli(["review", "open", "k1", "--print"], { configDir: cfg })).stdout).toBe(`${stub.url}/workbench?review=k1\n`);
    expect((await runCli(["review", "open", "nope", "--print"], { configDir: cfg })).code).toBe(EXIT.NOT_FOUND);
  });
});

describe("herdr", () => {
  it("makes one raw call over the herdr tunnel", async () => {
    const { cfg } = await box();
    const r = await runCli(["herdr", "call", "pane.list", '{"all":true}'], { configDir: cfg });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ method: "pane.list", params: { all: true } });
    const bad = await runCli(["herdr", "call", "boom"], { configDir: cfg });
    expect(bad.code).toBe(EXIT.FAILURE);
    expect(bad.stderr).toMatch(/herdr: no such method/);
    expect((await runCli(["herdr", "call", "x", "{nope"], { configDir: cfg })).code).toBe(EXIT.USAGE);
  });

  it.runIf(process.platform !== "win32")("serves a local socket that speaks to the box's herdr, private to this user", async () => {
    const { cfg } = await box();
    const where = path.join(tmpDir(), "h.sock");
    const stdout = capture();
    const ctrlC = new AbortController();
    const running = runCli(["herdr", "socket", where], { configDir: cfg, stdout, signal: ctrlC.signal });
    const deadline = Date.now() + 5000;
    while (!stdout.text() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect((await import("node:fs")).statSync(where).mode & 0o777).toBe(0o600);
    const line = await new Promise<string>((resolve, reject) => {
      const c = net.connect(where, () => c.write('{"id":"1","method":"ping","params":{}}\n'));
      c.once("data", (d) => {
        resolve(d.toString());
        c.destroy();
      });
      c.once("error", reject);
    });
    expect(JSON.parse(line)).toEqual({ id: "1", result: { method: "ping", params: {} } });
    ctrlC.abort();
    expect((await running).code).toBe(0);
    expect((await import("node:fs")).existsSync(where)).toBe(false);
  });
});

describe("the reviewer's leftovers", () => {
  it("lets mouse reports and focus changes pass a pending Ctrl-] without completing or cancelling it", () => {
    const f = new DetachFilter();
    const push = (s: string) => f.push(Buffer.from(s, "latin1"));
    expect(push("\x1d")).toEqual({ forward: Buffer.alloc(0), detach: false });
    expect(push("\x1b[<35;10;5M\x1b[O\x1b[I")).toEqual({ forward: Buffer.alloc(0), detach: false });
    expect(push("\x1b[M !!")).toEqual({ forward: Buffer.alloc(0), detach: false });
    expect(push("q").detach).toBe(true);
    // With nothing pending they pass straight through.
    const g = new DetachFilter();
    expect(g.push(Buffer.from("\x1b[<0;1;1m\x1b[I", "latin1")).forward.toString("latin1")).toBe("\x1b[<0;1;1m\x1b[I");
  });

  it("gives up waiting for a lock at its deadline", () => {
    const file = path.join(tmpDir(), "f.json");
    const t = Date.now();
    withFileLock(file, () => {
      expect(() => withFileLock(file, () => 1, { timeoutMs: 150 })).toThrow(/being changed by another agentbox/);
    });
    expect(Date.now() - t).toBeGreaterThanOrEqual(150);
  });

  it("does not count unanswered pings while the socket is paused for back-pressure", async () => {
    const { keepAlive } = await import("../src/keepalive.js");
    const server = http.createServer();
    const wss = new WebSocketServer({ server, autoPong: false });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await new Promise((r) => ws.once("open", r));
    let dead = false;
    ws.pause();
    const stop = keepAlive(ws, () => (dead = true), 10);
    await new Promise((r) => setTimeout(r, 100));
    expect(dead).toBe(false);
    ws.resume();
    await new Promise((r) => setTimeout(r, 100));
    expect(dead).toBe(true);
    stop();
    ws.terminate();
    wss.close();
    server.close();
  });
});
