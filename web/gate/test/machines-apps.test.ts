import http from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { decodeControl, decodeFrame, decodeOpen, encodeControl, FrameType, STREAM_WINDOW, StreamTable, type StreamOpen } from "../src/link/index.js";
import { MachineAppGrants, MachineApps, MachineAppTickets, MAX_APPS_PER_MACHINE, parseAppList, TICKET_MS } from "../src/machines/apps.js";
import { machinesUiCsp } from "../src/machines/pages.js";
import { setPassphrase } from "../src/machines/passphrase.js";
import { COST, PASSWORD, USER, cookieFrom, request, startHarness, type Harness } from "./helpers.js";

const MAIN = "box.example.com";
const MACHINES = "machines.example.com";
const APPS = "mapps.example.com";
const M_ORIGIN = `https://${MACHINES}`;
const ON = { publicUrl: `https://${MAIN}`, machinesHost: MACHINES, machineAppsHost: APPS };
const PASSPHRASE = "a passphrase for machines";

describe("the machine-apps registry", () => {
  it("takes a node's whole list, bounded and cleaned, and keeps an app's id for its port", () => {
    expect(parseAppList([{ port: 3000, name: "web<script>" }])).toEqual([{ port: 3000, name: "webscript" }]);
    expect(parseAppList([{ port: 0 }])).toBeNull();
    expect(parseAppList("x")).toBeNull();
    expect(parseAppList(Array.from({ length: MAX_APPS_PER_MACHINE + 1 }, (_, i) => ({ port: 1000 + i })))).toBeNull();
    const apps = new MachineApps(() => 5);
    const removed: string[][] = [];
    apps.onChange((c) => removed.push(c.ids));
    expect(apps.sync("m1", [{ port: 3000, name: "web" }, { port: 4000 }])).toBe(true);
    const [a, b] = apps.forMachine("m1");
    expect(a).toMatchObject({ port: 3000, name: "web", machineId: "m1" });
    expect(b?.name).toBe("port 4000");
    expect(a?.id).toMatch(/^[0-9a-f]{32}$/);
    apps.sync("m1", [{ port: 3000, name: "web" }]);
    expect(removed).toEqual([[b?.id]]);
    // Offline and back: the same address.
    apps.clear("m1");
    expect(apps.get(a?.id as string)).toBeUndefined();
    apps.sync("m1", [{ port: 3000 }]);
    expect(apps.forMachine("m1")[0]?.id).toBe(a?.id);
    // Revoked: forgotten, ids and all.
    apps.forget("m1");
    apps.sync("m1", [{ port: 3000 }]);
    expect(apps.forMachine("m1")[0]?.id).not.toBe(a?.id);
    expect(apps.sync("m1", "nope")).toBe(false);
  });

  it("opens with a ticket taken once, within 60 s, for its app; and a grant that cannot be forged", () => {
    let t = 1_000_000;
    const tickets = new MachineAppTickets(() => t);
    const app = "a".repeat(32);
    const one = tickets.issue("sess1", app);
    expect(tickets.take(one, "b".repeat(32))).toBeNull();
    const two = tickets.issue("sess1", app);
    expect(tickets.take(two, app)).toBe("sess1");
    expect(tickets.take(two, app)).toBeNull();
    const three = tickets.issue("sess1", app);
    t += TICKET_MS + 1;
    expect(tickets.take(three, app)).toBeNull();

    const grants = new MachineAppGrants();
    const g = grants.mint(app, "sess1", t + 60_000);
    expect(grants.verify(g, t)).toMatchObject({ appId: app, session: "sess1" });
    expect(grants.verify(g, t + 61_000)).toBeNull();
    expect(grants.verify(g.replace("sess1", "sess2"), t)).toBeNull();
    expect(new MachineAppGrants().verify(g, t)).toBeNull();
  });

  it("lets the machines page frame the machine-apps origin, and nothing else", () => {
    expect(machinesUiCsp(APPS)).toContain(`frame-src https://${APPS}`);
    expect(machinesUiCsp(APPS)).toContain("frame-ancestors 'none'");
  });
});

// --- end to end through the gate, with an in-process node ----------------------------------

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

async function machinesCookie(hh: Harness): Promise<{ machines: string; main: string }> {
  const login = await request(hh.base, "POST", "/_gate/login", { headers: { host: MAIN, origin: `https://${MAIN}` }, body: { username: USER, password: PASSWORD } });
  const ho = await request(hh.base, "GET", "/_gate/machines/handoff", { headers: { host: MAIN, cookie: cookieFrom(login) } });
  const n = /n=([A-Za-z0-9_-]+)/.exec(String(ho.headers.location))?.[1] as string;
  const res = await request(hh.base, "POST", "/signin", { headers: { host: MACHINES, origin: M_ORIGIN }, body: { nonce: n, passphrase: PASSPHRASE } });
  expect(res.status, res.body).toBe(200);
  return { machines: cookieFrom(res), main: cookieFrom(login) };
}

const mPost = (hh: Harness, cookie: string, p: string, body: object = {}) => request(hh.base, "POST", p, { headers: { host: MACHINES, origin: M_ORIGIN, cookie }, body });
const mGet = (hh: Harness, cookie: string, p: string) => request(hh.base, "GET", p, { headers: { host: MACHINES, cookie } });

async function join(hh: Harness, cookie: string) {
  const main = (p: string, body: object) => request(hh.base, "POST", p, { headers: { host: MAIN }, body });
  const j = (await main("/_gate/node/join/start", { name: "laptop", platform: "linux", arch: "x64", hostname: "lap" })).json<{ joinCode: string; userCode: string }>();
  expect((await mPost(hh, cookie, "/_gate/machines/joins/approve", { code: j.userCode })).status).toBe(200);
  return (await main("/_gate/node/join/poll", { joinCode: j.joinCode })).json<{ token: string; machineId: string }>();
}

const policy = { terminals: true, files: [], ports: true, share: false, updates: "auto", presenceHours: 12, paused: false, problem: null };

/** A node whose app streams reach a stand-in app, and whose other streams answer 404. */
async function fakeNode(hh: Harness, token: string) {
  const opens: StreamOpen[] = [];
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; open: StreamOpen | undefined }> = [];
  const openOf = new WeakMap<Duplex, StreamOpen>();
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    const open = openOf.get(req.socket);
    seen.push({ url: req.url ?? "", headers: req.headers, open });
    if (open?.app !== 3000) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end("{}");
    }
    if (req.url === "/go") {
      res.writeHead(302, { location: "http://localhost:3000/next" });
      return res.end();
    }
    if (req.method === "POST") {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"posted":true}');
    }
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "sid=1; Path=/; Domain=example.com", "strict-transport-security": "max-age=1" });
    res.end('<!doctype html><html><head></head><body><a href="/page">x</a></body></html>');
  });
  server.on("upgrade", (req, socket, head) => {
    seen.push({ url: req.url ?? "", headers: req.headers, open: openOf.get(socket) });
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
        if (decodeControl(f.payload).type === "ok") resolve();
        return;
      }
      if (f.type === FrameType.open) {
        const open = decodeOpen(f.payload);
        opens.push(open);
        const s = table.open(f.stream);
        openOf.set(s, open);
        server.emit("connection", s);
        return;
      }
      table.receive(f);
    });
    ws.once("error", reject);
  });
  const say = (apps: unknown) => ws.send(encodeControl({ type: "apps", apps }));
  return { opens, seen, ws, say };
}

const aGet = (hh: Harness, p: string, headers: Record<string, string> = {}) => request(hh.base, "GET", p, { headers: { host: APPS, ...headers } });

async function until<T>(f: () => Promise<T | null | undefined | false>): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}

describe("apps on a machine, on the machine-apps origin", () => {
  async function setUp() {
    h = await startHarness({ ...ON, trustedProxies: ["127.0.0.1"] });
    await setPassphrase({ store: h.gate.core.store, cost: COST }, PASSPHRASE);
    const cookies = await machinesCookie(h);
    const { token, machineId } = await join(h, cookies.machines);
    const node = await fakeNode(h, token);
    node.say([{ port: 3000, name: "web" }]);
    const hh = h;
    const app = await until(async () => (await mGet(hh, cookies.machines, `/_gate/machines/m/${machineId}/apps`)).json<{ apps: Array<{ id: string; port: number; url: string }> }>().apps[0]);
    return { hh, cookies, machineId, node, app };
  }

  async function opened(hh: Harness, cookie: string, machineId: string, appId: string): Promise<string> {
    const o = await mPost(hh, cookie, `/_gate/machines/m/${machineId}/apps/${appId}/open`);
    expect(o.status).toBe(200);
    const url = new URL(o.json<{ url: string }>().url);
    expect(url.host).toBe(APPS);
    const enter = await aGet(hh, `${url.pathname}${url.search}`);
    expect(enter.status).toBe(303);
    expect(enter.headers.location).toBe(`/${appId}/`);
    const set = String(enter.headers["set-cookie"]);
    expect(set).toMatch(new RegExp(`^__Secure-agentbox-mapp=[^;]+; Path=/${appId}/; Max-Age=\\d+; HttpOnly; Secure; SameSite=None$`));
    // A ticket answers once.
    expect((await aGet(hh, `${url.pathname}${url.search}`)).status).toBe(403);
    return set.split(";")[0] as string;
  }

  it("lists a node's apps on the machines origin only, apart from the box's apps", async () => {
    const { hh, cookies, app } = await setUp();
    expect(app.port).toBe(3000);
    expect(app.url).toBe(`https://${APPS}/${app.id}/`);
    const box = await request(hh.base, "GET", "/_gate/apps", { headers: { host: MAIN, cookie: cookies.main } });
    expect(box.body).not.toContain(app.id);
    expect(hh.gate.core.apps.get(app.id)).toBeUndefined();
  });

  it("serves an app only with a grant from the machines page, under the box's app policy", async () => {
    const { hh, cookies, machineId, node, app } = await setUp();
    // No grant: as if there were no such app. The machines session itself opens nothing here.
    expect((await aGet(hh, `/${app.id}/`)).status).toBe(404);
    expect((await aGet(hh, `/${app.id}/`, { cookie: cookies.machines })).status).toBe(404);
    // The machines origin's GETs mint nothing; a ticket from another session's page is refused.
    expect((await mGet(hh, cookies.machines, `/_gate/machines/m/${machineId}/apps/${app.id}/open`)).status).toBe(404);
    expect((await request(hh.base, "POST", `/_gate/machines/m/${machineId}/apps/${app.id}/open`, { headers: { host: MACHINES, origin: `https://${MAIN}`, cookie: cookies.machines }, body: {} })).status).toBe(403);

    const grant = await opened(hh, cookies.machines, machineId, app.id);
    const page = await aGet(hh, `/${app.id}/?q=1`, { cookie: `${grant}; theme=dark`, "sec-fetch-dest": "document", "x-forwarded-for": "198.51.100.9" });
    expect(page.status).toBe(200);
    const csp = [page.headers["content-security-policy"]].flat().join(" | ");
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain(`frame-ancestors ${M_ORIGIN}`);
    expect(csp).not.toContain("frame-ancestors 'self'");
    expect(page.headers["strict-transport-security"]).toBeUndefined();
    expect(page.headers["cross-origin-resource-policy"]).toBeUndefined();
    expect(String(page.headers["set-cookie"])).toBe(`sid=1; Path=/${app.id}/; Secure; SameSite=None`);
    // The page's paths are kept inside the app.
    expect(page.body).toContain(`/${app.id}/page`);
    // What the machine saw: its registered port in the open frame, no session, no grant, none of the gate's cookies, no address.
    const got = node.seen.at(-1);
    expect(got?.open).toEqual({ kind: "http", session: null, grant: null, app: 3000 });
    expect(got?.url).toBe("/?q=1");
    expect(got?.headers.host).toBe("localhost:3000");
    expect(got?.headers.cookie).toBe("theme=dark");
    expect(got?.headers["x-forwarded-for"]).toBeUndefined();
    // A redirect stays inside the app; it is never followed.
    const go = await aGet(hh, `/${app.id}/go`, { cookie: grant });
    expect(go.status).toBe(302);
    expect(go.headers.location).toBe(`/${app.id}/next`);
    // Writes: from the app's own (opaque) page, answered with its scoped CORS; never from another site.
    const evil = await request(hh.base, "POST", `/${app.id}/x`, { headers: { host: APPS, cookie: grant, origin: "https://evil.example" }, body: {} });
    expect(evil.status).toBe(403);
    const own = await request(hh.base, "POST", `/${app.id}/x`, { headers: { host: APPS, cookie: grant, origin: "null" }, body: {} });
    expect(own.status).toBe(200);
    expect(own.headers["access-control-allow-origin"]).toBe("null");
    // A grant is for its one app.
    node.say([{ port: 3000, name: "web" }, { port: 4000 }]);
    const other = await until(async () => (await mGet(hh, cookies.machines, `/_gate/machines/m/${machineId}/apps`)).json<{ apps: Array<{ id: string; port: number }> }>().apps.find((a) => a.port === 4000));
    expect((await aGet(hh, `/${other.id}/`, { cookie: grant.replace(app.id, other.id) })).status).toBe(404);

    // Signed out of machines: the grant opens nothing.
    await mPost(hh, cookies.machines, "/signout");
    expect((await aGet(hh, `/${app.id}/`, { cookie: grant })).status).toBe(404);
  });

  it("ends with its registration, and carries its WebSockets while it lasts", async () => {
    const { hh, cookies, machineId, node, app } = await setUp();
    const grant = await opened(hh, cookies.machines, machineId, app.id);
    const ws = new WebSocket(`ws://127.0.0.1:${hh.port}/${app.id}/ws`, { headers: { host: APPS, origin: "null", cookie: grant } });
    await new Promise((r, j) => {
      ws.once("open", r);
      ws.once("error", j);
    });
    ws.send("hi");
    expect(await new Promise<string>((r) => ws.once("message", (m) => r(String(m))))).toBe("echo hi");
    expect(node.opens.at(-1)).toMatchObject({ kind: "upgrade", app: 3000 });
    // Not without a grant, nor from another site.
    const refused = (headers: Record<string, string>) =>
      new Promise<number>((r) => {
        const w = new WebSocket(`ws://127.0.0.1:${hh.port}/${app.id}/ws`, { headers: { host: APPS, ...headers } });
        w.once("unexpected-response", (_q, res) => r(res.statusCode ?? 0));
        w.once("open", () => r(101));
        w.once("error", () => r(0));
      });
    expect(await refused({ origin: "null" })).toBe(404);
    expect(await refused({ origin: "https://evil.example", cookie: grant })).toBe(403);
    // The node takes it off: gone, and what it had open is cut.
    const closed = new Promise((r) => ws.once("close", r));
    node.say([]);
    await closed;
    await until(async () => (await aGet(hh, `/${app.id}/`, { cookie: grant })).status === 404);
  });

  it("is unreachable while the machine is offline, and needs the proxy", async () => {
    const { hh, cookies, machineId, node, app } = await setUp();
    const grant = await opened(hh, cookies.machines, machineId, app.id);
    node.ws.terminate();
    await until(async () => (await aGet(hh, `/${app.id}/`, { cookie: grant })).status === 404);
    expect((await mGet(hh, cookies.machines, `/_gate/machines/m/${machineId}/apps`)).json<{ apps: unknown[] }>().apps).toEqual([]);
  });
});
