import { afterEach, describe, expect, it } from "vitest";
import { callAdmin, startAdminServer } from "../src/admin.js";
import { MACHINES_HEADERS } from "../src/machines/headers.js";
import { setPassphrase } from "../src/machines/passphrase.js";
import { COST, PASSWORD, USER, cookieFrom, openWs, request, startHarness, type Harness, type Res } from "./helpers.js";

const MAIN = "box.example.com";
const MACHINES = "machines.example.com";
const APPS = "mapps.example.com";
const MAIN_ORIGIN = `https://${MAIN}`;
const M_ORIGIN = `https://${MACHINES}`;
const PASSPHRASE = "a passphrase for machines";
const ON = { publicUrl: MAIN_ORIGIN, machinesHost: MACHINES, machineAppsHost: APPS };
const nav = { "sec-fetch-mode": "navigate", accept: "text/html" };

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

/** Machines on, loopback trusted as the proxy (what the gate sees from Caddy). */
async function on(extra: Parameters<typeof startHarness>[0] = {}, deps: Parameters<typeof startHarness>[1] = {}): Promise<Harness> {
  h = await startHarness({ ...ON, trustedProxies: ["127.0.0.1"], ...extra }, deps);
  await setPassphrase({ store: h.gate.core.store, cost: COST }, PASSPHRASE);
  return h;
}

const at = (host: string, headers: Record<string, string> = {}) => ({ host, ...headers });
const get = (hh: Harness, host: string, path: string, headers: Record<string, string> = {}) =>
  request(hh.base, "GET", path, { headers: at(host, headers) });
const post = (hh: Harness, path: string, body: object, headers: Record<string, string> = {}) =>
  request(hh.base, "POST", path, { headers: at(MACHINES, { origin: M_ORIGIN, "sec-fetch-site": "same-origin", ...headers }), body });

async function mainLogin(hh: Harness): Promise<string> {
  const res = await request(hh.base, "POST", "/_gate/login", {
    headers: at(MAIN, { origin: MAIN_ORIGIN }),
    body: { username: USER, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return cookieFrom(res);
}

async function handoff(hh: Harness, mainCookie: string): Promise<string> {
  const res = await get(hh, MAIN, "/_gate/machines/handoff", { cookie: mainCookie });
  expect(res.status).toBe(302);
  const m = /^https:\/\/machines\.example\.com\/signin\?n=([A-Za-z0-9_-]{43})$/.exec(String(res.headers.location));
  expect(m, String(res.headers.location)).not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
}

/** All the way in: main sign-in, handoff, passphrase. Returns both cookies. */
async function machinesLogin(hh: Harness): Promise<{ main: string; machines: string }> {
  const main = await mainLogin(hh);
  const n = await handoff(hh, main);
  const res = await post(hh, "/signin", { nonce: n, passphrase: PASSPHRASE });
  expect(res.status, res.body).toBe(200);
  return { main, machines: cookieFrom(res) };
}

function expectStrictHeaders(res: Res, what: string): void {
  for (const [name, value] of MACHINES_HEADERS) {
    const got = String(res.headers[name.toLowerCase()] ?? "");
    if (name === "Content-Security-Policy") expect(got, `${what}: ${name}`).toContain("frame-ancestors 'none'");
    else if (name === "Cache-Control") expect(got, `${what}: ${name}`).not.toBe("");
    else expect(got, `${what}: ${name}`).toBe(value);
  }
  expect(Object.keys(res.headers).filter((k) => k.startsWith("access-control-")), what).toEqual([]);
}

describe("every gate route says which hosts it serves", () => {
  it("and none says nothing", async () => {
    h = await on();
    const routes = h.gate.routes;
    expect(routes.length).toBeGreaterThan(20);
    const untagged = routes.filter((r) => !r.hosts || r.hosts.length === 0).map((r) => `${String(r.method)} ${r.url}`);
    expect(untagged).toEqual([]);
    // The box's routes stay the box's; the machines origin's are its own.
    const byUrl = (url: string) => routes.find((r) => r.url === url)?.hosts;
    expect(byUrl("/login")).toEqual(["main"]);
    expect(byUrl("/_gate/machines/handoff")).toEqual(["main"]);
    expect(byUrl("/signin")).toEqual(["machines"]);
    expect(byUrl("/")).toEqual(["machines"]);
  });

  it("and machines routes exist only while machines are on", async () => {
    h = await startHarness();
    expect(h.gate.routes.filter((r) => r.hosts?.includes("machines") || r.url.startsWith("/_gate/machines"))).toEqual([]);
  });
});

describe("with machines off", () => {
  it("every Host is the box's and the machines routes are 404, as before", async () => {
    h = await startHarness({ publicUrl: MAIN_ORIGIN });
    const main = await mainLogin(h);
    expect((await get(h, MAIN, "/_gate/machines/handoff", { cookie: main })).status).toBe(404);
    // The machines hostname is just another name for the box: its paths are the box's.
    const signin = await get(h, MACHINES, "/signin", nav);
    expect(signin.status).toBe(302);
    expect(signin.headers.location).toBe("/login?next=%2Fsignin");
    expect((await get(h, "127.0.0.1:7900", "/login")).status).toBe(200);
  });

  it("/login does not return to the handoff", async () => {
    h = await startHarness();
    const res = await request(h.base, "POST", "/_gate/login", {
      headers: { origin: h.base },
      body: { username: USER, password: PASSWORD, next: "/_gate/machines/handoff" },
    });
    expect(res.json().next).toBe("/");
  });
});

describe("with machines on, hosts", () => {
  it("other than the three are misdirected (421), upgrades included", async () => {
    h = await on();
    for (const host of ["gate:7900", "127.0.0.1:7900", "localhost", "evil.example", "x.machines.example.com"]) {
      expect((await get(h, host, "/login")).status, host).toBe(421);
    }
    expect(await openWs(`ws://127.0.0.1:${h.port}/terminal/ws`, { host: "evil.example" })).toEqual({ status: 421 });
  });

  it("leave the box's origin as it was", async () => {
    h = await on();
    const main = await mainLogin(h);
    const res = await get(h, MAIN, "/vscode/", { cookie: main });
    expect(res.status).toBe(200);
    expect(res.json().echo).toBe("code");
    expect(res.headers["cross-origin-resource-policy"]).toBeUndefined();
  });

  it("answer the machines origin only through the proxy", async () => {
    h = await startHarness({ ...ON, trustedProxies: [] });
    for (const path of ["/", "/signin", "/_gate/machines/session"]) {
      const res = await get(h, MACHINES, path);
      expect(res.status, path).toBe(421);
      expectStrictHeaders(res, path);
    }
    expect((await get(h, APPS, "/")).status).toBe(421);
    expect(await openWs(`ws://127.0.0.1:${h.port}/x`, { host: MACHINES, origin: M_ORIGIN })).toEqual({ status: 421 });
    // The box's origin, straight from the sandbox, is as before: an anonymous visitor.
    expect((await get(h, MAIN, "/login")).status).toBe(200);
  });

  it("serve only registered apps on the machine-apps origin, in an opaque origin, and none of the gate's own routes", async () => {
    h = await on();
    for (const p of ["/", "/signin", "/_gate/machines/list", "/login", `/${"a".repeat(32)}/`]) {
      const res = await get(h, APPS, p);
      expect(res.status, p).toBe(404);
      expect(res.headers["content-security-policy"], p).toMatch(/^sandbox /);
      expect(res.headers["referrer-policy"], p).toBe("no-referrer");
    }
  });
});

describe("signing in to machines", () => {
  it("goes main session → handoff → passphrase, and opens the Machines page", async () => {
    h = await on();
    const main = await mainLogin(h);
    const handoffRes = await get(h, MAIN, "/_gate/machines/handoff", { cookie: main });
    expect(handoffRes.headers["referrer-policy"]).toBe("no-referrer");
    const n = await handoff(h, main);
    const page = await get(h, MACHINES, `/signin?n=${n}`, nav);
    expect(page.status).toBe(200);
    expect(page.body).toContain(`value="${n}"`);
    expect(page.body).toContain(MACHINES);
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    const res = await post(h, "/signin", { nonce: n, passphrase: PASSPHRASE });
    expect(res.status).toBe(200);
    const set = res.headers["set-cookie"]?.[0] ?? "";
    expect(set).toMatch(/^__Host-agentbox-machines=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    const shell = await get(h, MACHINES, "/", { ...nav, cookie: cookieFrom(res) });
    expect(shell.status).toBe(200);
    expect(shell.body).toContain('id="machines-root"');
    const me = await get(h, MACHINES, "/_gate/machines/session", { cookie: cookieFrom(res) });
    expect(me.json()).toMatchObject({ id: expect.any(String) });
    // The box's own session list does not show it.
    const list = await get(h, MAIN, "/_gate/sessions", { cookie: main });
    expect(list.json<unknown[]>().length).toBe(1);
  });

  it("sends a tab with no machines session to the handoff, through /login", async () => {
    h = await on();
    const res = await get(h, MACHINES, "/", nav);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${MAIN_ORIGIN}/_gate/machines/handoff`);
    expect((await get(h, MACHINES, "/", { accept: "application/json" })).status).toBe(401);
    const signedOut = await get(h, MAIN, "/_gate/machines/handoff", nav);
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.location).toBe("/login?next=%2F_gate%2Fmachines%2Fhandoff");
    // /login returns to exactly that route, and to no other gate path.
    const back = await request(h.base, "POST", "/_gate/login", {
      headers: at(MAIN, { origin: MAIN_ORIGIN }),
      body: { username: USER, password: PASSWORD, next: "/_gate/machines/handoff" },
    });
    expect(back.json().next).toBe("/_gate/machines/handoff");
    for (const next of ["/_gate/machines/handoff?x=1", "/_gate/machines/handoffx", "/_gate/machines/handoff/", "/_gate/session"]) {
      const r = await request(h.base, "POST", "/_gate/login", {
        headers: at(MAIN, { origin: MAIN_ORIGIN }),
        body: { username: USER, password: PASSWORD, next },
      });
      expect(r.json().next, next).toBe("/");
    }
  });

  it("needs the passphrase: a nonce alone, a wrong passphrase or the main password open nothing", async () => {
    h = await on();
    const main = await mainLogin(h);
    let n = await handoff(h, main);
    for (const passphrase of ["", "wrong passphrase!!", PASSWORD]) {
      const res = await post(h, "/signin", { nonce: n, passphrase });
      expect(res.status, passphrase).toBeGreaterThanOrEqual(400);
      expect(res.headers["set-cookie"]).toBeUndefined();
      // Each answer spends the nonce and hands back a fresh one.
      expect(res.json().nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await post(h, "/signin", { nonce: n, passphrase: PASSPHRASE })).json().error).toBe("restart");
      n = res.json().nonce as string;
    }
    // The passphrase alone, without a nonce from a live main session, is no sign-in.
    expect((await post(h, "/signin", { passphrase: PASSPHRASE })).json().error).toBe("restart");
    expect((await post(h, "/signin", { nonce: "A".repeat(43), passphrase: PASSPHRASE })).json().error).toBe("restart");
  });

  it("takes a nonce once, for 60 seconds, while its main session lives", async () => {
    let t = 1_750_000_000_000;
    h = await on({}, { now: () => t });
    const main = await mainLogin(h);
    const n = await handoff(h, main);
    expect((await post(h, "/signin", { nonce: n, passphrase: PASSPHRASE })).status).toBe(200);
    expect((await post(h, "/signin", { nonce: n, passphrase: PASSPHRASE })).json().error).toBe("restart");

    const late = await handoff(h, main);
    t += 61_000;
    expect((await get(h, MACHINES, `/signin?n=${late}`)).body).toContain("expired");
    expect((await post(h, "/signin", { nonce: late, passphrase: PASSPHRASE })).json().error).toBe("restart");

    const orphan = await handoff(h, main);
    expect((await request(h.base, "POST", "/_gate/logout", { headers: at(MAIN, { origin: MAIN_ORIGIN, cookie: main }) })).status).toBe(204);
    expect((await post(h, "/signin", { nonce: orphan, passphrase: PASSPHRASE })).json().error).toBe("restart");
  });

  it("does not hand a device token on", async () => {
    h = await on();
    const { token } = await h.gate.core.auth.createToken("laptop");
    const res = await get(h, MAIN, "/_gate/machines/handoff", { authorization: `Bearer ${token}` });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/login/);
  });

  it("is rate-limited as sign-ins are, with a budget of its own", async () => {
    h = await on();
    const main = await mainLogin(h);
    let n = await handoff(h, main);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await post(h, "/signin", { nonce: n, passphrase: `wrong passphrase ${i}` });
      codes.push(res.status);
      n = res.json().nonce as string;
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    // The box's own sign-in is not spent by it.
    await mainLogin(h);
  });

  it("says when no passphrase is set", async () => {
    h = await startHarness({ ...ON, trustedProxies: ["127.0.0.1"] });
    const main = await mainLogin(h);
    const n = await handoff(h, main);
    expect((await get(h, MACHINES, `/signin?n=${n}`)).body).toContain("machines enable");
    expect((await post(h, "/signin", { nonce: n, passphrase: PASSPHRASE })).status).toBe(503);
  });
});

describe("the machines origin's rules", () => {
  it("put the strict headers on every response, whatever produced it", async () => {
    h = await on();
    const { machines } = await machinesLogin(h);
    const responses: Array<[string, Res]> = [
      ["the shell", await get(h, MACHINES, "/", { cookie: machines })],
      ["the sign-in", await get(h, MACHINES, "/signin")],
      ["a 302", await get(h, MACHINES, "/", nav)],
      ["a 401", await get(h, MACHINES, "/_gate/machines/session")],
      ["a 404", await get(h, MACHINES, "/nothing-here")],
      ["a main route", await get(h, MACHINES, "/login")],
      ["a bad path", await get(h, MACHINES, "/a/../b")],
      ["a refused write", await post(h, "/signin", {}, { origin: MAIN_ORIGIN })],
      ["a bad body", await request(h.base, "POST", "/signin", { headers: at(MACHINES, { origin: M_ORIGIN, "content-type": "application/json" }), body: "{" })],
      ["an asset", await get(h, MACHINES, "/_gate/machines/assets/machines.js")],
      ["a preflight", await request(h.base, "OPTIONS", "/signin", { headers: at(MACHINES, { origin: MAIN_ORIGIN, "access-control-request-method": "POST" }) })],
      ["a GET from elsewhere", await get(h, MACHINES, "/_gate/machines/session", { origin: MAIN_ORIGIN, cookie: machines })],
    ];
    for (const [what, res] of responses) expectStrictHeaders(res, what);
  });

  it("refuse writes and upgrades from anything but the machines origin itself", async () => {
    h = await on();
    const { machines } = await machinesLogin(h);
    for (const headers of [
      { origin: MAIN_ORIGIN, "sec-fetch-site": "same-site" },
      { origin: MAIN_ORIGIN },
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "null", "sec-fetch-site": "same-origin" },
      { origin: M_ORIGIN, "sec-fetch-site": "same-site" },
    ]) {
      const res = await request(h.base, "POST", "/signout", { headers: at(MACHINES, { cookie: machines, ...headers }), body: {} });
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    const none = await request(h.base, "POST", "/signout", { headers: at(MACHINES, { cookie: machines }), body: {} });
    expect(none.status).toBe(403);
    // Still signed in: none of those reached the handler.
    expect((await get(h, MACHINES, "/_gate/machines/session", { cookie: machines })).status).toBe(200);
    for (const origin of [MAIN_ORIGIN, "https://evil.example"]) {
      expect(await openWs(`ws://127.0.0.1:${h.port}/anything`, { host: MACHINES, origin, cookie: machines })).toEqual({ status: 403 });
    }
    expect(await openWs(`ws://127.0.0.1:${h.port}/anything`, { host: MACHINES, cookie: machines })).toEqual({ status: 403 });
    expect(await openWs(`ws://127.0.0.1:${h.port}/anything`, { host: MACHINES, origin: M_ORIGIN, cookie: machines })).toEqual({ status: 404 });
  });

  it("refuse a service worker's script", async () => {
    h = await on();
    expect((await get(h, MACHINES, "/_gate/machines/assets/machines.js", { "service-worker": "script" })).status).toBe(403);
  });

  it("accept no main session, device token or other bearer there", async () => {
    h = await on();
    const main = await mainLogin(h);
    const { token } = await h.gate.core.auth.createToken("laptop");
    const mainSecret = main.split("=")[1] as string;
    for (const headers of [
      { cookie: main },
      { cookie: `__Host-agentbox-machines=${mainSecret}` },
      { authorization: `Bearer ${token}` },
      { authorization: "Bearer abn_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    ]) {
      expect((await get(h, MACHINES, "/_gate/machines/session", headers)).status, JSON.stringify(headers)).toBe(401);
      expect((await get(h, MACHINES, "/", { ...headers, accept: "application/json" })).status).toBe(401);
    }
    // And none of the box's own routes answer there at all.
    for (const path of ["/_gate/session", "/_gate/tokens", "/_gate/apps", "/settings/devices", "/cli/install", "/login"]) {
      expect((await get(h, MACHINES, path, { cookie: main })).status, path).toBe(404);
    }
    // Even alongside a good machines session, Authorization is refused.
    const { machines } = await machinesLogin(h);
    expect((await get(h, MACHINES, "/_gate/machines/session", { cookie: machines, authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it("keep the machines cookie out of the box, and out of the sandbox", async () => {
    h = await on();
    const { main, machines } = await machinesLogin(h);
    // On the box's origin it is no session...
    expect((await get(h, MAIN, "/vscode/", { cookie: machines, accept: "application/json" })).status).toBe(401);
    // ...and stripped before anything is forwarded.
    const res = await get(h, MAIN, "/api/x", { cookie: `${main}; ${machines}; theme=dark` });
    expect(res.status).toBe(200);
    expect(res.json<{ headers: Record<string, string> }>().headers.cookie).toBe("theme=dark");
  });
});

describe("a machines session ends", () => {
  async function stillIn(hh: Harness, machines: string): Promise<boolean> {
    return (await get(hh, MACHINES, "/_gate/machines/session", { cookie: machines })).status === 200;
  }

  it("with signing out of machines", async () => {
    h = await on();
    const { machines } = await machinesLogin(h);
    const res = await post(h, "/signout", {}, { cookie: machines });
    expect(res.status).toBe(204);
    expect(res.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
    expect(await stillIn(h, machines)).toBe(false);
  });

  it("with a change of the main password", async () => {
    h = await on();
    const { main, machines } = await machinesLogin(h);
    const res = await request(h.base, "POST", "/_gate/password", {
      headers: at(MAIN, { origin: MAIN_ORIGIN, cookie: main }),
      body: { current: PASSWORD, next: "another long password" },
    });
    expect(res.status).toBe(200);
    expect(await stillIn(h, machines)).toBe(false);
  });

  it("with a change of the passphrase, revoke-all and machines-off, on the host", async () => {
    h = await on();
    const { core } = h.gate;
    const admin = await startAdminServer(core.config.adminSocket, { config: core.config, store: core.store, auth: core.auth, now: core.now });
    try {
      let { machines } = await machinesLogin(h);
      const changed = await callAdmin(core.config.adminSocket, "machines-passphrase", { passphrase: "a different passphrase" });
      expect(changed).toMatchObject({ status: 200, body: { ok: true, endedMachinesSessions: 1 } });
      expect(await stillIn(h, machines)).toBe(false);
      // The old passphrase no longer works; the new one does.
      const main = await mainLogin(h);
      const n = await handoff(h, main);
      const old = await post(h, "/signin", { nonce: n, passphrase: PASSPHRASE });
      expect(old.status).toBe(401);
      const ok = await post(h, "/signin", { nonce: old.json().nonce as string, passphrase: "a different passphrase" });
      expect(ok.status).toBe(200);
      machines = cookieFrom(ok);

      expect((await callAdmin(core.config.adminSocket, "revoke-all"))?.status).toBe(200);
      expect(await stillIn(h, machines)).toBe(false);

      await setPassphrase({ store: core.store, cost: COST }, PASSPHRASE);
      ({ machines } = await machinesLogin(h));
      expect(await callAdmin(core.config.adminSocket, "machines-off")).toMatchObject({ status: 200, body: { endedMachinesSessions: 1 } });
      expect(await stillIn(h, machines)).toBe(false);
      expect(core.store.data.machines.passphrase).toBeNull();
      const status = await callAdmin(core.config.adminSocket, "status");
      expect(status?.body.machines).toMatchObject({ on: true, host: MACHINES, passphraseSet: false, sessions: 0 });
      // The passphrase is checked like a password, and is never the password.
      expect((await callAdmin(core.config.adminSocket, "machines-passphrase", { passphrase: "short" }))?.status).toBe(400);
      expect((await callAdmin(core.config.adminSocket, "machines-passphrase", { passphrase: PASSWORD }))?.status).toBe(400);
    } finally {
      admin.close();
    }
  });
});
