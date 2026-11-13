import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  decodeControl,
  decodeFrame,
  decodeOpen,
  encodeControl,
  FrameType,
  STREAM_WINDOW,
  StreamBudget,
  StreamTable,
  type ControlMessage,
  type StreamOpen,
} from "../src/link/index.js";
import { SECRETS_FILE } from "../src/machines/claude-token.js";
import { setPassphrase } from "../src/machines/passphrase.js";
import { COST, PASSWORD, USER, cookieFrom, request, startHarness, type Harness } from "./helpers.js";

const MAIN = "box.example.com";
const MACHINES = "machines.example.com";
const M_ORIGIN = `https://${MACHINES}`;
const ON = { publicUrl: `https://${MAIN}`, machinesHost: MACHINES, machineAppsHost: "mapps.example.com" };
const PASSPHRASE = "a passphrase for machines";

let h: Harness | null = null;
const closers: Array<() => void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) {
    try {
      c();
    } catch {
      // already gone
    }
  }
  await h?.close();
  h = null;
});

async function on(budget?: StreamBudget): Promise<Harness> {
  h = await startHarness({ ...ON, trustedProxies: ["127.0.0.1"] }, budget ? { link: { budget } } : {});
  await setPassphrase({ store: h.gate.core.store, cost: COST }, PASSPHRASE);
  return h;
}

async function machinesCookie(hh: Harness): Promise<string> {
  const login = await request(hh.base, "POST", "/_gate/login", { headers: { host: MAIN, origin: `https://${MAIN}` }, body: { username: USER, password: PASSWORD } });
  const ho = await request(hh.base, "GET", "/_gate/machines/handoff", { headers: { host: MAIN, cookie: cookieFrom(login) } });
  const n = /n=([A-Za-z0-9_-]+)/.exec(String(ho.headers.location))?.[1] as string;
  const res = await request(hh.base, "POST", "/signin", { headers: { host: MACHINES, origin: M_ORIGIN }, body: { nonce: n, passphrase: PASSPHRASE } });
  expect(res.status, res.body).toBe(200);
  return cookieFrom(res);
}

const mGet = (hh: Harness, cookie: string, p: string, headers: Record<string, string> = {}) => request(hh.base, "GET", p, { headers: { host: MACHINES, cookie, ...headers } });
const mPost = (hh: Harness, cookie: string, p: string, body: object = {}) =>
  request(hh.base, "POST", p, { headers: { host: MACHINES, origin: M_ORIGIN, cookie }, body });

async function join(hh: Harness, cookie: string) {
  const main = (p: string, body: object) => request(hh.base, "POST", p, { headers: { host: MAIN }, body });
  const j = (await main("/_gate/node/join/start", { name: "laptop", platform: "linux", arch: "x64", hostname: "lap" })).json<{ joinCode: string; userCode: string }>();
  expect((await mPost(hh, cookie, "/_gate/machines/joins/approve", { code: j.userCode })).status).toBe(200);
  return (await main("/_gate/node/join/poll", { joinCode: j.joinCode })).json<{ token: string; machineId: string }>();
}

const policy = { terminals: true, files: [], ports: false, share: false, updates: "auto", presenceHours: 12, paused: false, problem: null };

interface FakeNode {
  opens: StreamOpen[];
  seen: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
  control: ControlMessage[];
  ws: WebSocket;
}

/**
 * An in-process node: its link, and an HTTP server that listens on nothing,
 * fed each stream the gate opens — answering as a compromised machine might.
 */
async function fakeNode(hh: Harness, token: string): Promise<FakeNode> {
  const opens: StreamOpen[] = [];
  const seen: FakeNode["seen"] = [];
  const control: ControlMessage[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    const url = req.url ?? "";
    if (url === "/json") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", etag: '"v1"', "x-other": "1" });
      return res.end('{"ok":true}');
    }
    if (url === "/html") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<script>alert(1)</script>");
    }
    if (url === "/redirect") {
      res.writeHead(302, { location: "https://evil.example/" });
      return res.end();
    }
    if (url === "/cookie") {
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "set-cookie": "__Host-agentbox-machines=planted; Path=/; Secure",
        "access-control-allow-origin": "*",
        "content-security-policy": "script-src *",
        "content-disposition": 'inline; filename="../x.html"',
        location: "/elsewhere",
      });
      return res.end("hello");
    }
    if (url === "/presence/challenge") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ challenge: "c".repeat(43), salt: "s", iterations: 600000 }));
    }
    if (url === "/presence/answer") {
      let b = "";
      req.on("data", (c: Buffer) => (b += c.toString()));
      req.on("end", () => {
        const { answer } = JSON.parse(b) as { answer: string };
        if (answer !== "right") {
          res.writeHead(401, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "wrong", message: "not right", grant: "leaked_grant" }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ grant: "granted_1", expiresAt: Date.now() + 60_000 }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  server.on("upgrade", (req, socket, head) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (m) => ws.send(`echo ${m.toString()}`)));
  });

  const ws = new WebSocket(`ws://127.0.0.1:${hh.port}/_gate/node`, { headers: { host: MAIN, authorization: `Bearer ${token}` } });
  closers.push(() => ws.terminate());
  const table = new StreamTable((f) => ws.send(f), STREAM_WINDOW);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      ws.send(
        encodeControl({
          type: "hello",
          protocol: 1,
          version: "0.1.0",
          nonce: "N".repeat(43),
          platform: "linux",
          arch: "x64",
          hostname: "lap",
          cpu: { model: "cpu", cores: 2 },
          ramBytes: 1,
          disks: [],
          gpus: [],
          docker: false,
          claude: null,
          policy,
        }),
      );
    });
    ws.on("message", (data: Buffer) => {
      const f = decodeFrame(data);
      if (f.type === FrameType.control) {
        const m = decodeControl(f.payload);
        if (m.type === "ok") resolve();
        else control.push(m);
        return;
      }
      if (f.type === FrameType.open) {
        opens.push(decodeOpen(f.payload));
        server.emit("connection", table.open(f.stream));
        return;
      }
      table.receive(f);
    });
    ws.once("error", reject);
  });
  return { opens, seen, control, ws };
}

describe("a machine's server, over its link", () => {
  it("is reached under /m/<id>/ with a machines session only, and gets no credential", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const { token, machineId } = await join(hh, cookie);

    // Offline: 503; unknown: 404; no session: 401.
    expect((await mGet(hh, cookie, `/m/${machineId}/json`)).status).toBe(503);
    expect((await mGet(hh, cookie, `/m/${"0".repeat(24)}/json`)).status).toBe(404);
    const node = await fakeNode(hh, token);
    expect((await mGet(hh, "", `/m/${machineId}/json`)).status).toBe(401);
    expect((await mGet(hh, cookie, `/m/${machineId}/json`, { authorization: `Bearer ${token}` })).status).toBe(401);
    // Not from the box's origin, which serves what the sandbox controls.
    expect((await request(hh.base, "POST", `/m/${machineId}/json`, { headers: { host: MACHINES, origin: `https://${MAIN}`, cookie }, body: {} })).status).toBe(403);
    expect((await request(hh.base, "GET", `/m/${machineId}/json`, { headers: { host: MAIN, cookie } })).status).not.toBe(200);

    const res = await mGet(hh, cookie, `/m/${machineId}/json`, { "x-forwarded-for": "198.51.100.1" });
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers.etag).toBe('"v1"');
    expect(res.headers["x-other"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toContain("sandbox; default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");

    const last = node.seen.at(-1);
    expect(last?.url).toBe("/json");
    expect(last?.headers.cookie).toBeUndefined();
    expect(last?.headers.authorization).toBeUndefined();
    expect(last?.headers["x-forwarded-for"]).toBeUndefined();
    // The node is told which machines session asks, never its cookie.
    const id = hh.gate.core.store.data.machines.sessions[0]?.id;
    expect(node.opens.at(-1)).toEqual({ kind: "http", session: id, grant: null });
  });

  it("rebuilds the machine's headers: HTML and redirects become 502, Set-Cookie and the rest are dropped", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const { token, machineId } = await join(hh, cookie);
    await fakeNode(hh, token);

    const html = await mGet(hh, cookie, `/m/${machineId}/html`);
    expect(html.status).toBe(502);
    expect(html.body).not.toContain("<script>");
    expect(html.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect((await mGet(hh, cookie, `/m/${machineId}/redirect`)).status).toBe(502);

    const c = await mGet(hh, cookie, `/m/${machineId}/cookie`);
    expect(c.status).toBe(200);
    expect(c.body).toBe("hello");
    expect(c.headers["set-cookie"]).toBeUndefined();
    expect(c.headers.location).toBeUndefined();
    expect(c.headers["access-control-allow-origin"]).toBeUndefined();
    expect(c.headers["content-security-policy"]).not.toContain("script-src *");
    expect(c.headers["content-disposition"]).toBe("attachment");
  });

  it("carries a WebSocket to the machine from the machines origin only", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const { token, machineId } = await join(hh, cookie);
    const node = await fakeNode(hh, token);
    const open = (headers: Record<string, string>) =>
      new Promise<{ ws: WebSocket } | { status: number }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${hh.port}/m/${machineId}/ws/terminal`, { headers: { host: MACHINES, cookie, ...headers } });
        ws.on("error", () => {});
        closers.push(() => ws.terminate());
        ws.once("unexpected-response", (_q, r) => resolve({ status: r.statusCode ?? 0 }));
        ws.once("open", () => resolve({ ws }));
      });
    expect(await open({ origin: `https://${MAIN}` })).toEqual({ status: 403 });
    expect(await open({ origin: M_ORIGIN, cookie: "" })).toEqual({ status: 401 });
    const ok = await open({ origin: M_ORIGIN });
    if (!("ws" in ok)) throw new Error(`refused: ${ok.status}`);
    const reply = new Promise<string>((r) => ok.ws.once("message", (m) => r(m.toString())));
    ok.ws.send("hi");
    expect(await reply).toBe("echo hi");
    expect(node.opens.at(-1)?.kind).toBe("upgrade");
    expect(node.seen.at(-1)?.headers.cookie).toBeUndefined();
  });

  it("holds the presence grant the machine issues, and presents it on each stream for that session alone", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const { token, machineId } = await join(hh, cookie);
    const node = await fakeNode(hh, token);
    const sessionId = hh.gate.core.store.data.machines.sessions[0]?.id;

    // A GET has no side effects: the challenge is a POST.
    const ch = await mPost(hh, cookie, `/_gate/machines/m/${machineId}/presence/challenge`);
    expect(ch.status).toBe(200);
    expect(ch.json()).toMatchObject({ challenge: "c".repeat(43), session: sessionId, machine: machineId });

    const wrong = await mPost(hh, cookie, `/_gate/machines/m/${machineId}/presence`, { challenge: "x", answer: "wrong" });
    expect(wrong.status).toBe(401);
    expect(wrong.body).not.toContain("leaked_grant");
    expect((await mGet(hh, cookie, `/_gate/machines/m/${machineId}/presence`)).json()).toMatchObject({ granted: false });

    const right = await mPost(hh, cookie, `/_gate/machines/m/${machineId}/presence`, { challenge: "x", answer: "right" });
    expect(right.status).toBe(200);
    // The page never sees the grant itself.
    expect(right.body).not.toContain("granted_1");
    expect((await mGet(hh, cookie, `/_gate/machines/m/${machineId}/presence`)).json()).toMatchObject({ granted: true });

    await mGet(hh, cookie, `/m/${machineId}/json`);
    expect(node.opens.at(-1)).toEqual({ kind: "http", session: sessionId, grant: "granted_1" });

    // Another machines session gets none of it.
    const other = await machinesCookie(hh);
    await mGet(hh, other, `/m/${machineId}/json`);
    expect(node.opens.at(-1)?.grant).toBeNull();
  });

  it("queues a stream past the gate-wide budget, then refuses it with 503", async () => {
    const hh = await on(new StreamBudget(STREAM_WINDOW, 150));
    const cookie = await machinesCookie(hh);
    const { token, machineId } = await join(hh, cookie);
    await fakeNode(hh, token);
    // One socket holds the whole budget...
    const held = new WebSocket(`ws://127.0.0.1:${hh.port}/m/${machineId}/ws/x`, { headers: { host: MACHINES, cookie, origin: M_ORIGIN } });
    closers.push(() => held.terminate());
    await new Promise((r) => held.once("open", r));
    expect(hh.gate.core.machines.links.budgetInUse()).toBe(STREAM_WINDOW);
    // ...so the next waits, and is refused when the wait is over.
    const t = Date.now();
    const res = await mGet(hh, cookie, `/m/${machineId}/json`);
    expect(res.status).toBe(503);
    expect(Date.now() - t).toBeGreaterThanOrEqual(140);
    // Room again once it closes.
    held.close();
    await new Promise((r) => setTimeout(r, 100));
    expect((await mGet(hh, cookie, `/m/${machineId}/json`)).status).toBe(200);
  });
});

describe("the shared Claude token", () => {
  it("is write-only, kept out of gate.json, and pushed only to opted-in machines", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const { token, machineId } = await join(hh, cookie);
    const node = await fakeNode(hh, token);
    // Generated here, never a real token's value.
    const secret = `sk-test-${"q".repeat(10)}${Math.random().toString(36).slice(2)}`;

    expect((await mPost(hh, cookie, "/_gate/machines/claude-token", { token: "short" })).status).toBe(400);
    const set = await mPost(hh, cookie, "/_gate/machines/claude-token", { token: secret });
    expect(set.status).toBe(200);
    expect(set.body).not.toContain(secret);
    const status = await mGet(hh, cookie, "/_gate/machines/claude-token");
    expect(status.json()).toMatchObject({ set: true, generation: 1 });
    expect(status.body).not.toContain(secret);
    expect((await mGet(hh, cookie, "/admin")).body).not.toContain(secret);
    await hh.gate.core.store.flush();
    expect(fs.readFileSync(path.join(hh.dataDir, "gate.json"), "utf8")).not.toContain(secret);
    const file = path.join(hh.dataDir, SECRETS_FILE);
    expect(fs.readFileSync(file, "utf8")).toContain(secret);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    // Not opted in: it is told to hold none.
    await new Promise((r) => setTimeout(r, 50));
    expect(node.control.filter((m) => m.type === "claude-token").every((m) => m.token === null)).toBe(true);
    expect((await mGet(hh, cookie, "/_gate/machines/list")).json<{ machines: Array<{ claudeTokenStale: boolean }> }>().machines[0]?.claudeTokenStale).toBe(false);

    expect((await mPost(hh, cookie, `/_gate/machines/m/${machineId}/opt-in`, { claudeToken: true })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(node.control.at(-1)).toEqual({ type: "claude-token", token: secret, generation: 1 });

    // Replaced while it is offline: it is listed as on the old one, and given the new one when it is back.
    node.ws.terminate();
    await new Promise((r) => setTimeout(r, 100));
    const next = `${secret}x`;
    await mPost(hh, cookie, "/_gate/machines/claude-token", { token: next });
    const stale = (await mGet(hh, cookie, "/_gate/machines/claude-token")).json<{ stale: Array<{ id: string }> }>().stale;
    expect(stale.map((s) => s.id)).toEqual([machineId]);
    const again = await fakeNode(hh, token);
    await new Promise((r) => setTimeout(r, 50));
    expect(again.control.at(-1)).toEqual({ type: "claude-token", token: next, generation: 2 });
    expect((await mGet(hh, cookie, "/_gate/machines/claude-token")).json<{ stale: unknown[] }>().stale).toEqual([]);

    // Opted out: told to delete it.
    await mPost(hh, cookie, `/_gate/machines/m/${machineId}/opt-in`, { claudeToken: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(again.control.at(-1)).toEqual({ type: "claude-token", token: null, generation: 2 });
  });
});
