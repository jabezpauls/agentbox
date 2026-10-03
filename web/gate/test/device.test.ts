import { afterEach, describe, expect, it } from "vitest";
import { normalizeUserCode } from "../src/device.js";
import { PASSWORD, login, openWs, request, sameOrigin, startHarness, type Harness } from "./helpers.js";

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
const start = (hh: Harness, name = "my-laptop") => request(hh.base, "POST", "/_gate/device/start", { body: { name } });
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
    expect(pending.json()).toMatchObject({ userCode: s.userCode, name: "my-laptop", ip: "127.0.0.1" });

    // Approving hands out full access: it needs the password in the same
    // request.
    const unconfirmed = await request(h.base, "POST", "/_gate/device/approve", { headers: sameOrigin(h, { cookie }), body: { userCode: s.userCode } });
    expect(unconfirmed.status).toBe(403);
    expect(unconfirmed.json()).toMatchObject({ error: "password_required" });
    const approve = await request(h.base, "POST", "/_gate/device/approve", {
      headers: sameOrigin(h, { cookie }),
      body: { userCode: s.userCode, password: PASSWORD },
    });
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
    expect((await request(h.base, "POST", "/api/rpc", { headers: bearer, body: "{}" })).status).toBe(200);
    const ws = await openWs(`ws://127.0.0.1:${h.port}/terminal/ws`, bearer);
    expect("ws" in ws).toBe(true);
    if ("ws" in ws) ws.ws.close();

    const tokens = (await request(h.base, "GET", "/_gate/tokens", { headers: bearer })).json<Array<{ name: string; current: boolean; lastIp: string }>>();
    expect(tokens).toEqual([expect.objectContaining({ name: "my-laptop", current: true, lastIp: "127.0.0.1" })]);
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
    await request(h.base, "POST", "/_gate/device/approve", { headers: sameOrigin(h, { cookie }), body: { userCode: s.userCode, password: PASSWORD } });
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
      const approve = await request(h.base, "POST", "/_gate/device/approve", { headers: sameOrigin(h, headers), body: { userCode: s.userCode, password: PASSWORD } });
      expect([401, 403]).toContain(approve.status);
    }
    // And a session cannot be tricked into approving from another site.
    const cookie = await login(h);
    const forged = await request(h.base, "POST", "/_gate/device/approve", {
      headers: { cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: `userCode=${s.userCode}&password=${encodeURIComponent(PASSWORD)}`,
    });
    expect(forged.status).toBe(403);
    expect((await poll(h, s.deviceCode)).json()).toEqual({ error: "authorization_pending" });
  });

  it("lets one address keep only three logins waiting, so it cannot lock the owner's CLI out", async () => {
    const c = clock();
    // The loopback connection plays the proxy, so each request can name its client.
    h = await startHarness({ trustedProxies: ["127.0.0.1"] }, { now: c.now });
    const from = (ip: string, name = "x") =>
      request(h!.base, "POST", "/_gate/device/start", { headers: { "x-agentbox-client-ip": ip }, body: { name } });
    // The reviewer's attack: one address starting logins as fast as it may.
    const attacker: number[] = [];
    const fourth: string[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await from("198.51.100.7");
      attacker.push(res.status);
      if (i === 3) fourth.push(String(res.json().message));
    }
    c.advance(61_000);
    for (let i = 0; i < 10; i++) attacker.push((await from("198.51.100.7")).status);
    expect(attacker.filter((st) => st === 200)).toHaveLength(3);
    expect(fourth[0]).toMatch(/3 device logins from your address are already waiting/);
    // The owner's CLI, from anywhere else, is unaffected.
    expect((await from("203.0.113.1")).status).toBe(200);
    // The same /64 is the same client.
    expect((await from("2001:db8:1:2::1")).status).toBe(200);
    expect((await from("2001:db8:1:2::2")).status).toBe(200);
    expect((await from("2001:db8:1:2::3")).status).toBe(200);
    expect((await from("2001:db8:1:2::4")).status).toBe(429);
  });

  it("lets one IPv6 /48 keep only ten logins waiting, however many /64s it spreads over", async () => {
    h = await startHarness({ trustedProxies: ["127.0.0.1"] });
    const from = (ip: string) =>
      request(h!.base, "POST", "/_gate/device/start", { headers: { "x-agentbox-client-ip": ip }, body: { name: "x" } });
    const statuses: number[] = [];
    // Thirty-four /64s of one /48, three each: enough to fill the hundred.
    for (let i = 0; i < 34; i++) for (let j = 1; j <= 3; j++) statuses.push((await from(`2001:db8:7:${i.toString(16)}::${j}`)).status);
    expect(statuses.filter((st) => st === 200)).toHaveLength(10);
    // Another allocation, and IPv4, are unaffected.
    expect((await from("2001:db8:8::1")).status).toBe(200);
    expect((await from("203.0.113.9")).status).toBe(200);
  });

  it("holds at most a hundred waiting logins in all", async () => {
    h = await startHarness({ trustedProxies: ["127.0.0.1"] });
    const statuses: number[] = [];
    for (let i = 0; i < 34; i++) {
      for (let j = 0; j < 3; j++) {
        const res = await request(h.base, "POST", "/_gate/device/start", { headers: { "x-agentbox-client-ip": `10.9.${i}.1` }, body: { name: "x" } });
        statuses.push(res.status);
      }
    }
    expect(statuses.filter((st) => st === 200)).toHaveLength(100);
    expect(statuses.slice(100)).toEqual([429, 429]);
  });

  it("limits how fast one address may start logins", async () => {
    h = await startHarness();
    const cookie = await login(h);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await start(h, `d${i}`);
      statuses.push(res.status);
      // Deny each at once, so the waiting cap is never what refuses.
      if (res.status === 200) {
        await request(h.base, "POST", "/_gate/device/deny", { headers: sameOrigin(h, { cookie }), body: { userCode: res.json<Started>().userCode } });
      }
    }
    expect(statuses.slice(0, 10).every((st) => st === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("mints exactly one token when the same code is approved twice at once", async () => {
    h = await startHarness();
    const cookie = await login(h);
    const s = (await start(h)).json<Started>();
    const approve = () =>
      request(h!.base, "POST", "/_gate/device/approve", { headers: sameOrigin(h!, { cookie }), body: { userCode: s.userCode, password: PASSWORD } });
    const [a, b] = await Promise.all([approve(), approve()]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect(h.gate.core.store.data.tokens).toHaveLength(1);
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

    // The form asks for the password: approving needs it, every time.
    expect(page.body).toContain('name="password"');
    const wrong = await request(h.base, "POST", "/_gate/device/approve", {
      headers: sameOrigin(h, { cookie, "content-type": "application/x-www-form-urlencoded" }),
      body: `userCode=${s.userCode}&password=nope`,
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toContain("The password is not right.");
    // A same-origin form post from a page that withholds its origin (Origin:
    // null, Sec-Fetch-Site: same-origin) is still accepted.
    const done = await request(h.base, "POST", "/_gate/device/approve", {
      headers: { cookie, origin: "null", "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
      body: `userCode=${s.userCode}&password=${encodeURIComponent(PASSWORD)}`,
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
    // The owner, with the password in the request.
    const unconfirmed = await request(h.base, "DELETE", `/_gate/tokens/${a.record.id}`, { headers: sameOrigin(h, { cookie }) });
    expect(unconfirmed.status).toBe(403);
    const del = await request(h.base, "DELETE", `/_gate/tokens/${a.record.id}`, { headers: sameOrigin(h, { cookie }), body: { password: PASSWORD } });
    expect(del.status).toBe(204);
    expect((await request(h.base, "GET", "/", { headers: { authorization: `Bearer ${a.token}` } })).status).toBe(401);
    // A token may not revoke another.
    const c2 = await h.gate.core.auth.createToken("c");
    const other = await request(h.base, "DELETE", `/_gate/tokens/${c2.record.id}`, { headers: { authorization: `Bearer ${b.token}` } });
    expect(other.status).toBe(403);
    expect((await request(h.base, "GET", "/", { headers: { authorization: `Bearer ${c2.token}` } })).status).toBe(200);
    // The CLI's logout: a token revoking itself, by id or as `self`.
    const self = await request(h.base, "DELETE", "/_gate/tokens/self", { headers: { authorization: `Bearer ${b.token}` } });
    expect(self.status).toBe(204);
    expect((await request(h.base, "GET", "/", { headers: { authorization: `Bearer ${b.token}` } })).status).toBe(401);
    const byId = await request(h.base, "DELETE", `/_gate/tokens/${c2.record.id}`, { headers: { authorization: `Bearer ${c2.token}` } });
    expect(byId.status).toBe(204);
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
