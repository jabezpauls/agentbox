import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { runAdmin } from "../src/admin.js";
import {
  CONTROL_PER_SECOND,
  decodeControl,
  decodeFrame,
  encodeControl,
  encodeFrame,
  FrameType,
  verifyRevoke,
  type ControlMessage,
} from "../src/link/index.js";
import { AUDIT_KEEP_FILE } from "../src/machines/audit.js";
import { StreamRefused } from "../src/machines/link.js";
import { setPassphrase } from "../src/machines/passphrase.js";
import { COST, PASSWORD, USER, cookieFrom, openWs, request, startHarness, type Harness } from "./helpers.js";

const MAIN = "box.example.com";
const MACHINES = "machines.example.com";
const ON = { publicUrl: `https://${MAIN}`, machinesHost: MACHINES, machineAppsHost: "mapps.example.com" };
const PASSPHRASE = "a passphrase for machines";
const FAST = { pingMs: 60, missedPings: 2, stalePongMs: 150, helloTimeoutMs: 300 };

let h: Harness | null = null;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await h?.close();
  h = null;
});

let clock = Date.now();
const now = () => clock;

async function on(extra: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  clock = Date.now();
  h = await startHarness({ ...ON, trustedProxies: ["127.0.0.1"], ...extra }, { now, link: FAST });
  await setPassphrase({ store: h.gate.core.store, cost: COST }, PASSPHRASE);
  return h;
}

const mainPost = (hh: Harness, p: string, body: object) => request(hh.base, "POST", p, { headers: { host: MAIN }, body });

async function machinesCookie(hh: Harness): Promise<string> {
  const login = await request(hh.base, "POST", "/_gate/login", {
    headers: { host: MAIN, origin: `https://${MAIN}` },
    body: { username: USER, password: PASSWORD },
  });
  const main = cookieFrom(login);
  const ho = await request(hh.base, "GET", "/_gate/machines/handoff", { headers: { host: MAIN, cookie: main } });
  const n = /n=([A-Za-z0-9_-]+)/.exec(String(ho.headers.location))?.[1] as string;
  const res = await request(hh.base, "POST", "/signin", {
    headers: { host: MACHINES, origin: `https://${MACHINES}` },
    body: { nonce: n, passphrase: PASSPHRASE },
  });
  expect(res.status, res.body).toBe(200);
  return cookieFrom(res);
}

const mPost = (hh: Harness, cookie: string, p: string, body: object = {}) =>
  request(hh.base, "POST", p, { headers: { host: MACHINES, origin: `https://${MACHINES}`, cookie }, body });
const mGet = (hh: Harness, cookie: string, p: string) => request(hh.base, "GET", p, { headers: { host: MACHINES, cookie } });

/** Ask to join as `name`; returns the join code and the code shown on the machine. */
async function startJoin(hh: Harness, name = "laptop", extra: object = {}) {
  const res = await mainPost(hh, "/_gate/node/join/start", { name, platform: "linux", arch: "x64", hostname: "lap", ...extra });
  expect(res.status, res.body).toBe(200);
  return res.json<{ joinCode: string; userCode: string; name: string; approveAt: string }>();
}

/** All the way: join, approve by the typed code, collect. */
async function join(hh: Harness, cookie: string, name = "laptop") {
  const j = await startJoin(hh, name);
  expect((await mPost(hh, cookie, "/_gate/machines/joins/approve", { code: j.userCode })).status).toBe(200);
  const got = (await mainPost(hh, "/_gate/node/join/poll", { joinCode: j.joinCode })).json<{ status: string; token: string; machineId: string; name: string }>();
  expect(got.status).toBe("approved");
  return got;
}

const policy = { terminals: true, files: [{ path: "/home/x/code", mode: "write" }], ports: false, share: false, updates: "auto", presenceHours: 12, paused: false, problem: null };
const NONCE = "N".repeat(43);
function hello(extra: object = {}): ControlMessage {
  return {
    type: "hello",
    protocol: 1,
    version: "0.1.0",
    nonce: NONCE,
    platform: "linux",
    arch: "x64",
    hostname: "lap",
    cpu: { model: "Test CPU", cores: 8 },
    ramBytes: 16 * 2 ** 30,
    disks: [{ path: "/home/x/code", freeBytes: 2 ** 30 }],
    gpus: [{ name: "RTX", memoryMiB: 8192 }],
    docker: true,
    claude: null,
    policy,
    ...extra,
  };
}

interface NodeConn {
  ws: WebSocket;
  messages: ControlMessage[];
  frames: Array<{ type: number; stream: number }>;
  closed: Promise<{ code: number; reason: string }>;
  next(): Promise<ControlMessage>;
}

/** An in-process node: a real WebSocket to the gate's link endpoint. */
function connect(hh: Harness, token: string | null, headers: Record<string, string> = {}): Promise<NodeConn | { status: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hh.port}/_gate/node`, {
      headers: { host: MAIN, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    sockets.push(ws);
    const messages: ControlMessage[] = [];
    const frames: NodeConn["frames"] = [];
    const waiters: Array<(m: ControlMessage) => void> = [];
    ws.on("message", (data: Buffer) => {
      const f = decodeFrame(data);
      if (f.type !== FrameType.control) return frames.push({ type: f.type, stream: f.stream });
      const m = decodeControl(f.payload);
      const w = waiters.shift();
      if (w) w(m);
      else messages.push(m);
    });
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (code, reason) => r({ code, reason: reason.toString() })));
    ws.once("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      res.resume();
    });
    ws.once("open", () =>
      resolve({
        ws,
        messages,
        frames,
        closed,
        next: () => (messages.length ? Promise.resolve(messages.shift() as ControlMessage) : new Promise((r) => waiters.push(r))),
      }),
    );
    ws.once("error", reject);
  });
}

async function link(hh: Harness, token: string, extra: object = {}): Promise<{ conn: NodeConn; answer: ControlMessage }> {
  const conn = await connect(hh, token);
  if ("status" in conn) throw new Error(`refused: ${conn.status}`);
  conn.ws.send(encodeControl(hello(extra)));
  return { conn, answer: await conn.next() };
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("joining a machine", () => {
  it("needs the code the machine shows typed on the machines origin, and hands out its token once", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const j = await startJoin(hh);
    expect(j.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    // Where to type it, without the code in it.
    expect(j.approveAt).toBe(`https://${MACHINES}/admin`);
    expect(JSON.stringify(j)).not.toContain(`admin?`);

    // The Admin page lists it with the address the gate saw, never its code.
    const pending = (await mGet(hh, cookie, "/_gate/machines/joins")).json<{ joins: Array<Record<string, unknown>> }>().joins;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ name: "laptop", platform: "linux", hostname: "lap", ip: "127.0.0.1" });
    expect(JSON.stringify(pending)).not.toContain(j.userCode);
    const admin = await mGet(hh, cookie, "/admin");
    expect(admin.status).toBe(200);
    expect(admin.body).toContain("127.0.0.1");
    expect(admin.body).not.toContain(j.userCode);

    expect((await mainPost(hh, "/_gate/node/join/poll", { joinCode: j.joinCode })).json()).toEqual({ status: "pending" });
    // Not without a machines session; not from the box's origin; not with a wrong code.
    expect((await mPost(hh, "", "/_gate/machines/joins/approve", { code: j.userCode })).status).toBe(401);
    expect((await mainPost(hh, "/_gate/machines/joins/approve", { code: j.userCode })).status).toBe(404);
    expect((await mPost(hh, cookie, "/_gate/machines/joins/approve", { code: "BCDF-GHJK" })).status).toBe(404);
    expect(hh.gate.core.machines.registry.all()).toHaveLength(0);

    expect((await mPost(hh, cookie, "/_gate/machines/joins/approve", { code: j.userCode.toLowerCase() })).status).toBe(200);
    const got = (await mainPost(hh, "/_gate/node/join/poll", { joinCode: j.joinCode })).json<Record<string, string>>();
    expect(got.status).toBe("approved");
    expect(got.token).toMatch(/^abn_[A-Za-z0-9_-]{43}$/);
    expect((await mainPost(hh, "/_gate/node/join/poll", { joinCode: j.joinCode })).json()).toEqual({ status: "expired" });
    const machines = hh.gate.core.machines.registry.all();
    expect(machines).toHaveLength(1);
    expect(machines[0]?.tokenHash).not.toContain(got.token);
    expect(JSON.stringify(hh.gate.core.store.data)).not.toContain(got.token);
    // The token's issue is in the log that is never rotated.
    expect(fs.readFileSync(path.join(hh.dataDir, AUDIT_KEEP_FILE), "utf8")).toContain("token-issued");
  });

  it("suffixes a name already in use; the URL uses the id", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const a = await join(hh, cookie, "Laptop");
    const b = await join(hh, cookie, "laptop");
    expect([a.name, b.name]).toEqual(["laptop", "laptop-2"]);
    expect(a.machineId).not.toBe(b.machineId);
  });

  it("keeps at most 3 waiting, for 10 minutes", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const js = [await startJoin(hh, "a"), await startJoin(hh, "b"), await startJoin(hh, "c")];
    expect((await mainPost(hh, "/_gate/node/join/start", { name: "d" })).status).toBe(429);
    clock += 10 * 60_000 + 1;
    expect((await mPost(hh, cookie, "/_gate/machines/joins/approve", { code: js[0]?.userCode ?? "" })).status).toBe(404);
    expect((await mainPost(hh, "/_gate/node/join/poll", { joinCode: js[1]?.joinCode })).json()).toEqual({ status: "expired" });
    expect((await mainPost(hh, "/_gate/node/join/start", { name: "d" })).status).toBe(200);
  });

  it("a denied join gets no token", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const j = await startJoin(hh);
    const id = (await mGet(hh, cookie, "/_gate/machines/joins")).json<{ joins: Array<{ id: string }> }>().joins[0]?.id;
    expect((await mPost(hh, cookie, "/_gate/machines/joins/deny", { id })).status).toBe(200);
    expect((await mainPost(hh, "/_gate/node/join/poll", { joinCode: j.joinCode })).json()).toEqual({ status: "denied" });
    expect(hh.gate.core.machines.registry.all()).toHaveLength(0);
  });

  it("re-joins in place only with the old token", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const first = await join(hh, cookie);
    const wrong = await mainPost(hh, "/_gate/node/join/start", { name: "x", rejoin: { machineId: first.machineId, token: `abn_${"x".repeat(43)}` } });
    expect(wrong.status).toBe(409);
    const j = await startJoin(hh, "ignored", { rejoin: { machineId: first.machineId, token: first.token } });
    expect(j.name).toBe("laptop");
    await mPost(hh, cookie, "/_gate/machines/joins/approve", { code: j.userCode });
    const again = (await mainPost(hh, "/_gate/node/join/poll", { joinCode: j.joinCode })).json<Record<string, string>>();
    expect(again.machineId).toBe(first.machineId);
    expect(hh.gate.core.machines.registry.all()).toHaveLength(1);
    // The old token stops working.
    expect(await connect(hh, first.token)).toEqual({ status: 401 });
    expect((await link(hh, again.token as string)).answer.type).toBe("ok");
  });
});

describe("the link", () => {
  it("takes a node token, through the proxy only, and shows the machine online with its specs", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const m = await join(hh, cookie);
    expect(await connect(hh, null)).toEqual({ status: 401 });
    expect(await connect(hh, `abn_${"z".repeat(43)}`)).toEqual({ status: 401 });
    // A device token, or a session, is not a node token.
    const { answer, conn } = await link(hh, m.token);
    expect(answer).toEqual({ type: "ok", machineId: m.machineId, name: "laptop" });
    const list = (await mGet(hh, cookie, "/_gate/machines/list")).json<{ machines: Array<Record<string, unknown>> }>().machines;
    expect(list[0]).toMatchObject({ id: m.machineId, state: "online", specs: { hostname: "lap", gpus: [{ name: "RTX", memoryMiB: 8192 }], docker: true } });
    expect(JSON.stringify(list)).not.toContain("tokenHash");
    expect((await mGet(hh, cookie, "/")).body).toContain("online");

    // The node's policy summary changes are taken; anything else it says does nothing.
    conn.ws.send(encodeControl({ type: "policy", policy: { ...policy, terminals: false } }));
    conn.ws.send(encodeControl({ type: "revoke-everything" }));
    await until(() => hh.gate.core.machines.registry.get(m.machineId)?.specs?.policy.terminals === false);

    conn.ws.close();
    await until(() => !hh.gate.core.machines.links.isOnline(m.machineId));
    const after = (await mGet(hh, cookie, "/_gate/machines/list")).json<{ machines: Array<{ state: string }> }>().machines;
    expect(after[0]?.state).toBe("offline");
  });

  it("is refused straight from the sandbox, with machines off, and as plain HTTP", async () => {
    h = await startHarness({ ...ON, trustedProxies: [] }, { link: FAST });
    await setPassphrase({ store: h.gate.core.store, cost: COST }, PASSPHRASE);
    expect(await connect(h, `abn_${"z".repeat(43)}`)).toEqual({ status: 421 });
    await h.close();
    h = await startHarness({ publicUrl: `https://${MAIN}`, trustedProxies: ["127.0.0.1"] }, { link: FAST });
    expect(await connect(h, `abn_${"z".repeat(43)}`)).toEqual({ status: 404 });
    expect((await request(h.base, "GET", "/_gate/node", { headers: { host: MAIN } })).status).toBe(404);
    await h.close();
    h = await on();
    expect((await request(h.base, "GET", "/_gate/node", { headers: { host: MAIN } })).status).toBe(426);
  });

  it("opens nothing else with a node token", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const m = await join(hh, cookie);
    const auth = { authorization: `Bearer ${m.token}` };
    for (const p of ["/api/files", "/_gate/session", "/_gate/tokens"]) {
      expect((await request(hh.base, "GET", p, { headers: { host: MAIN, ...auth } })).status, p).toBe(401);
    }
    expect(await openWs(`ws://127.0.0.1:${hh.port}/_gate/tunnel?target=herdr`, { host: MAIN, ...auth })).toEqual({ status: 401 });
    expect(await openWs(`ws://127.0.0.1:${hh.port}/terminal/ws`, { host: MAIN, ...auth })).toEqual({ status: 401 });
    expect((await request(hh.base, "GET", "/_gate/machines/list", { headers: { host: MACHINES, ...auth } })).status).toBe(401);
  });

  it("closes on a bad hello, a late one, or a flood of control messages", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const m = await join(hh, cookie);
    let c = (await connect(hh, m.token)) as NodeConn;
    c.ws.send(encodeControl({ type: "policy", policy }));
    expect((await c.closed).code).toBe(1002);
    c = (await connect(hh, m.token)) as NodeConn;
    c.ws.send(encodeControl(hello({ pad: "x".repeat(17 * 1024) })));
    expect((await c.closed).code).toBe(1002);
    c = (await connect(hh, m.token)) as NodeConn;
    expect((await c.closed).code).toBe(1002);

    const { conn } = await link(hh, m.token);
    for (let i = 0; i <= CONTROL_PER_SECOND; i++) conn.ws.send(encodeControl({ type: "policy", policy }));
    expect((await conn.closed).code).toBe(1008);
  });

  it("never lets a node open a stream", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const m = await join(hh, cookie);
    const { conn } = await link(hh, m.token);
    conn.ws.send(encodeFrame(FrameType.open, 7, Buffer.from("{}")));
    conn.ws.send(encodeFrame(FrameType.data, 8, Buffer.from("GET / HTTP/1.1\r\n\r\n")));
    await until(() => conn.frames.length === 2);
    expect(conn.frames).toEqual([
      { type: FrameType.close, stream: 7 },
      { type: FrameType.close, stream: 8 },
    ]);
    await expect(hh.gate.core.machines.links.openStream(m.machineId, "http")).rejects.toBeInstanceOf(StreamRefused);
    await expect(hh.gate.core.machines.links.openStream("nope", "http")).rejects.toThrow(/offline/);
  });

  it("is offline after two missed pings", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const m = await join(hh, cookie);
    const { conn } = await link(hh, m.token);
    expect(hh.gate.core.machines.links.isOnline(m.machineId)).toBe(true);
    // The machine sleeps: nothing it would say gets out.
    (conn.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    await until(() => !hh.gate.core.machines.links.isOnline(m.machineId), 2_000);
  });
});

describe("one link per machine", () => {
  it("refuses a second while the first answers, and says so", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const m = await join(hh, cookie);
    const first = await link(hh, m.token);
    const second = await link(hh, m.token);
    expect(second.answer).toMatchObject({ type: "duplicate", retryAfterMs: 5 * 60_000 });
    expect((await second.conn.closed).code).toBe(4002);
    expect(first.conn.ws.readyState).toBe(WebSocket.OPEN);
    const list = (await mGet(hh, cookie, "/_gate/machines/list")).json<{ machines: Array<{ duplicateAt: number | null }> }>().machines;
    expect(list[0]?.duplicateAt).not.toBeNull();
    expect((await mGet(hh, cookie, "/_gate/machines/audit")).body).toContain("duplicate");
  });

  it("replaces a first that no longer answers", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const m = await join(hh, cookie);
    const first = await link(hh, m.token);
    (first.conn.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const second = await link(hh, m.token);
    expect(second.answer.type).toBe("ok");
    expect(hh.gate.core.machines.links.isOnline(m.machineId)).toBe(true);
  });
});

describe("revoking a machine", () => {
  it("tells it, signed, on its live link, and again on any later one; removed, its token is unknown", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const m = await join(hh, cookie);
    const { conn } = await link(hh, m.token);
    expect((await mPost(hh, cookie, `/_gate/machines/m/${m.machineId}/remove`)).status).toBe(409);
    expect((await mPost(hh, cookie, `/_gate/machines/m/${m.machineId}/revoke`)).status).toBe(200);
    const told = await conn.next();
    expect(told.type).toBe("revoked");
    expect(verifyRevoke(m.token, m.machineId, NONCE, told.mac)).toBe(true);
    expect((await conn.closed).code).toBe(4001);

    // Offline when revoked: its next link is told, bound to that link's nonce.
    const nonce2 = "M".repeat(43);
    const again = await link(hh, m.token, { nonce: nonce2 });
    expect(again.answer.type).toBe("revoked");
    expect(verifyRevoke(m.token, m.machineId, nonce2, again.answer.mac)).toBe(true);
    expect(verifyRevoke(m.token, m.machineId, NONCE, again.answer.mac)).toBe(false);

    expect((await mPost(hh, cookie, `/_gate/machines/m/${m.machineId}/remove`)).status).toBe(200);
    expect(await connect(hh, m.token)).toEqual({ status: 401 });
    const audit = (await mGet(hh, cookie, "/_gate/machines/audit")).body;
    for (const kind of ["revoked", "removed", "online"]) expect(audit).toContain(kind);
  });
});

describe("turning machines off", () => {
  it("ends every link and takes none until they are on again", async () => {
    const hh = await on();
    const cookie = await machinesCookie(hh);
    const m = await join(hh, cookie);
    const { conn } = await link(hh, m.token);
    const out = await runAdmin(
      { config: hh.gate.core.config, store: hh.gate.core.store, auth: hh.gate.core.auth, links: hh.gate.core.machines.links, now },
      "machines-off",
    );
    expect(out.closedLinks).toBe(1);
    expect((await conn.closed).code).toBe(4004);
    expect(await connect(hh, m.token)).toEqual({ status: 404 });
    // The machine is still joined: on again, it links again.
    await setPassphrase({ store: hh.gate.core.store, cost: COST }, PASSPHRASE);
    expect((await link(hh, m.token)).answer.type).toBe("ok");
  });
});
