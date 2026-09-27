import { afterEach, describe, expect, it } from "vitest";
import { normalizeUserCode } from "../src/device.js";
import { login, openWs, request, sameOrigin, startHarness, type Harness } from "./helpers.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function clock(start = 1_750_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

interface Started {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  interval: number;
  expiresIn: number;
}

// The CLI sends no Origin and no cookie: these two calls must work without them.
const start = (hh: Harness, name = "jabe-laptop") => request(hh.base, "POST", "/_gate/device/start", { body: { name } });
const poll = (hh: Harness, deviceCode: string) => request(hh.base, "POST", "/_gate/device/poll", { body: { deviceCode } });

describe("the device login", () => {
  it("issues a token once the owner approves, and exactly once", async () => {
    const c = clock();
    h = await startHarness({}, { now: c.now });
    const res = await start(h);
    expect(res.status).toBe(200);
    const s = res.json<Started>();
    expect(s.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(s.verifyUrl).toBe(`${h.base}/settings/devices?code=${s.userCode}`);
    expect(s).toMatchObject({ interval: 5, expiresIn: 600 });
    // The device code is stored only as a digest.
    expect(JSON.stringify(h.gate.core.store.data)).not.toContain(s.deviceCode);

    expect((await poll(h, s.deviceCode)).json()).toEqual({ error: "authorization_pending" });
    expect((await poll(h, s.deviceCode)).json()).toEqual({ error: "slow_down" });

    const cookie = await login(h);
    const pending = await request(h.base, "GET", `/_gate/device/pending?code=${s.userCode.toLowerCase().replace("-", "")}`, { headers: { cookie } });
    expect(pending.json()).toMatchObject({ userCode: s.userCode, name: "jabe-laptop", ip: "127.0.0.1" });

    const approve = await request(h.base, "POST", "/_gate/device/approve", { headers: sameOrigin(h, { cookie }), body: { userCode: s.userCode } });
    expect(approve.status).toBe(200);

    c.advance(5_000);
    const got = await poll(h, s.deviceCode);
    expect(got.status).toBe(200);
    const { token } = got.json<{ token: string }>();
    expect(token).toMatch(/^abx_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(h.gate.core.store.data)).not.toContain(token);

    // Collected once; the device code is spent.
    expect((await poll(h, s.deviceCode)).json()).toEqual({ error: "expired_token" });

    // The token opens every authenticated route, and is stripped on the way in.
    const bearer = { authorization: `Bearer ${token}` };
    const through = await request(h.base, "GET", "/terminal/", { headers: bearer });
    expect(through.status).toBe(200);
    expect(through.json<{ headers: Record<string, string> }>().headers.authorization).toBeUndefined();
    expect((await request(h.base, "GET", "/_gate/version", { headers: bearer })).json()).toEqual({ version: "9.9.9-test" });
    // No Origin needed: a token is not an ambient credential.
    expect((await request(h.base, "POST", "/workbench/api/rpc", { headers: bearer, body: "{}" })).status).toBe(200);
    const ws = await openWs(`ws://127.0.0.1:${h.port}/terminal/ws`, bearer);
    expect("ws" in ws).toBe(true);
    if ("ws" in ws) ws.ws.close();

    const tokens = (await request(h.base, "GET", "/_gate/tokens", { headers: bearer })).json<Array<{ name: string; current: boolean; lastIp: string }>>();
    expect(tokens).toEqual([expect.objectContaining({ name: "jabe-laptop", current: true, lastIp: "127.0.0.1" })]);
  });

  it("a denied login gets nothing", async () => {
    h = await startHarness();
    const s = (await start(h)).json<Started>();
    const cookie = await login(h);
    const deny = await request(h.base, "POST", "/_gate/device/deny", { headers: sameOrigin(h, { cookie }), body: { userCode: s.userCode } });
    expect(deny.status).toBe(200);
    expect((await poll(h, s.deviceCode)).json()).toEqual({ error: "access_denied" });
    expect(h.gate.core.store.data.tokens).toHaveLength(0);
  });

  it("expires after ten minutes, revoking a token nobody collected", async () => {
    const c = clock();
    h = await startHarness({}, { now: c.now });
    const s = (await start(h)).json<Started>();
    const cookie = await login(h);
    await request(h.base, "POST", "/_gate/device/approve", { headers: sameOrigin(h, { cookie }), body: { userCode: s.userCode } });
    expect(h.gate.core.store.data.tokens).toHaveLength(1);
    c.advance(10 * 60_000);
    expect((await poll(h, s.deviceCode)).json()).toEqual({ error: "expired_token" });
    expect(h.gate.core.store.data.tokens).toHaveLength(0);
  });

  it("only a signed-in browser can see or approve a login — not a token, not nobody", async () => {
    h = await startHarness();
    const s = (await start(h)).json<Started>();
    const { token } = await h.gate.core.auth.createToken("other");
    for (const headers of [{}, { authorization: `Bearer ${token}` }]) {
      const pending = await request(h.base, "GET", `/_gate/device/pending?code=${s.userCode}`, { headers });
      expect([401, 403]).toContain(pending.status);
      const approve = await request(h.base, "POST", "/_gate/device/approve", { headers: sameOrigin(h, headers), body: { userCode: s.userCode } });
      expect([401, 403]).toContain(approve.status);
    }
    // And a session cannot be tricked into approving from another site.
    const cookie = await login(h);
    const forged = await request(h.base, "POST", "/_gate/device/approve", {
      headers: { cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: `userCode=${s.userCode}`,
    });
    expect(forged.status).toBe(403);
    expect((await poll(h, s.deviceCode)).json()).toEqual({ error: "authorization_pending" });
  });

  it("is rate-limited per address and bounded in how many can wait", async () => {
    h = await startHarness();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await start(h, `d${i}`)).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("needs a device name", async () => {
    h = await startHarness();
    expect((await start(h, "")).status).toBe(400);
    expect((await request(h.base, "POST", "/_gate/device/start", { body: {} })).status).toBe(400);
  });

  it("normalises the code the owner types", () => {
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDF-GHJK");
    expect(normalizeUserCode(" BCDF GHJK ")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("AAAA-BBBB")).toBeNull(); // vowels are never issued
    expect(normalizeUserCode("BCDF")).toBeNull();
  });
});

describe("the approval page", () => {
  it("sends a visitor without a session to sign in first, and back", async () => {
    h = await startHarness();
    const res = await request(h.base, "GET", "/settings/devices?code=BCDF-GHJK", { headers: { accept: "text/html" } });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/login?next=${encodeURIComponent("/settings/devices?code=BCDF-GHJK")}`);
  });

  it("shows the waiting login, approves by plain form post, and says so", async () => {
    h = await startHarness();
    const s = (await start(h, "build <server>")).json<Started>();
    const cookie = await login(h);
    const page = await request(h.base, "GET", `/settings/devices?code=${s.userCode}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.body).toContain("Allow “build &#60;server&#62;” full access?");
    expect(page.body).toContain(s.userCode);

    const done = await request(h.base, "POST", "/_gate/device/approve", {
      headers: sameOrigin(h, { cookie, "content-type": "application/x-www-form-urlencoded" }),
      body: `userCode=${s.userCode}`,
    });
    expect(done.status).toBe(200);
    expect(done.body).toContain("Device approved");
    expect((await poll(h, s.deviceCode)).status).toBe(200);
  });

  it("says when a code matches nothing", async () => {
    h = await startHarness();
    const cookie = await login(h);
    const page = await request(h.base, "GET", "/settings/devices?code=BCDF-GHJK", { headers: { cookie } });
    expect(page.body).toContain("No login is waiting for BCDF-GHJK");
  });
});

describe("device tokens", () => {
  it("can be revoked, by the owner or by the token itself", async () => {
    h = await startHarness();
    const a = await h.gate.core.auth.createToken("a");
    const b = await h.gate.core.auth.createToken("b");
    const cookie = await login(h);
    const del = await request(h.base, "DELETE", `/_gate/tokens/${a.record.id}`, { headers: sameOrigin(h, { cookie }) });
    expect(del.status).toBe(204);
    expect((await request(h.base, "GET", "/", { headers: { authorization: `Bearer ${a.token}` } })).status).toBe(401);
    // The CLI's logout: a token revoking itself.
    const self = await request(h.base, "DELETE", `/_gate/tokens/${b.record.id}`, { headers: { authorization: `Bearer ${b.token}` } });
    expect(self.status).toBe(204);
    expect((await request(h.base, "GET", "/", { headers: { authorization: `Bearer ${b.token}` } })).status).toBe(401);
  });

  it("describe themselves", async () => {
    h = await startHarness();
    const { token } = await h.gate.core.auth.createToken("ci");
    const res = await request(h.base, "GET", "/_gate/session", { headers: { authorization: `Bearer ${token}` } });
    expect(res.json()).toMatchObject({ kind: "token", name: "ci" });
  });

  it("cannot list or end browser sessions", async () => {
    h = await startHarness();
    const { token } = await h.gate.core.auth.createToken("ci");
    expect((await request(h.base, "GET", "/_gate/sessions", { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    expect((await request(h.base, "POST", "/_gate/totp/setup", { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
  });
});
