import { afterEach, describe, expect, it, vi } from "vitest";
import { hotp, stepAt } from "../src/totp.js";
import { PASSWORD, USER, cookieFrom, login, request, sameOrigin, startHarness, type Harness } from "./helpers.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function clock(start = 1_750_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function signIn(hh: Harness, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  return request(hh.base, "POST", "/_gate/login", { headers: sameOrigin(hh, extraHeaders), body });
}

const authed = (cookie: string) => async (path: string) => (await request(h!.base, "GET", path, { headers: { cookie } })).status;

describe("signing in", () => {
  it("refuses a wrong password or username with the same calm answer, and sets no cookie", async () => {
    h = await startHarness();
    const wrongPw = await signIn(h, { username: USER, password: "nope" });
    const wrongUser = await signIn(h, { username: "root", password: PASSWORD });
    for (const res of [wrongPw, wrongUser]) {
      expect(res.status).toBe(401);
      expect(res.json()).toMatchObject({ error: "invalid" });
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
    expect(wrongPw.json().message).toBe(wrongUser.json().message);
  });

  it("sets a host-only, secure, http-only session cookie that opens the box", async () => {
    h = await startHarness();
    const res = await signIn(h, { username: USER, password: PASSWORD, next: "/vscode/" });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true, next: "/vscode/" });
    const set = res.headers["set-cookie"]?.[0] ?? "";
    expect(set).toMatch(/^__Host-agentbox=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect(await authed(cookieFrom(res))("/vscode/")).toBe(200);
  });

  it("makes a remembered session a 30-day cookie", async () => {
    h = await startHarness();
    const res = await signIn(h, { username: USER, password: PASSWORD, remember: true });
    expect(res.headers["set-cookie"]?.[0]).toContain("Max-Age=2592000");
  });

  it("refuses a sign-in posted from another site", async () => {
    h = await startHarness();
    const res = await request(h.base, "POST", "/_gate/login", { headers: { origin: "https://evil.example" }, body: { username: USER, password: PASSWORD } });
    expect(res.status).toBe(403);
    const none = await request(h.base, "POST", "/_gate/login", { body: { username: USER, password: PASSWORD } });
    expect(none.status).toBe(403);
  });

  it("works as a plain form post, with JavaScript off", async () => {
    h = await startHarness();
    const form = (body: string) =>
      request(h!.base, "POST", "/_gate/login", { headers: sameOrigin(h!, { "content-type": "application/x-www-form-urlencoded" }), body });
    const bad = await form(`username=${USER}&password=nope&next=%2Fvscode%2F`);
    expect(bad.status).toBe(401);
    expect(bad.headers["content-type"]).toContain("text/html");
    expect(bad.body).toContain("don’t match");
    expect(bad.body).toContain('name="next" value="/vscode/"');
    const ok = await form(`username=${USER}&password=${encodeURIComponent(PASSWORD)}&next=%2Fvscode%2F&remember=1`);
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe("/vscode/");
    expect(ok.headers["set-cookie"]?.[0]).toContain("Max-Age=");
  });

  it("never redirects off the box after signing in", async () => {
    h = await startHarness();
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example", "/login", "/€uro"]) {
      const res = await signIn(h, { username: USER, password: PASSWORD, next });
      expect(res.json().next, next).toBe("/");
    }
  });

  it("says plainly when no password has been set", async () => {
    h = await startHarness({ seedPasswordHash: null });
    const res = await signIn(h, { username: USER, password: PASSWORD });
    expect(res.status).toBe(503);
    expect(res.json().error).toBe("not_set_up");
  });

  it("describes the session it made", async () => {
    h = await startHarness();
    const cookie = await login(h);
    const res = await request(h.base, "GET", "/_gate/session", { headers: { cookie } });
    expect(res.json()).toMatchObject({ kind: "session", user: USER, remember: false, twoFactor: false });
    expect((await request(h.base, "GET", "/_gate/session")).status).toBe(401);
  });
});

describe("rate limits and lockout", () => {
  it("refuse the sixth attempt in a minute before any bcrypt work — even with the right password", async () => {
    const c = clock();
    h = await startHarness({}, { now: c.now });
    const verify = vi.spyOn(h.gate.core.passwords, "verify");
    for (let i = 0; i < 5; i++) expect((await signIn(h, { username: USER, password: "wrong" })).status).toBe(401);
    expect(verify).toHaveBeenCalledTimes(5);
    const res = await signIn(h, { username: USER, password: PASSWORD });
    expect(res.status).toBe(429);
    expect(res.json()).toMatchObject({ error: "rate" });
    expect(res.json().message).toMatch(/Too many attempts\. Try again in \d+ seconds?\./);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(verify).toHaveBeenCalledTimes(5);
  });

  it("lock an address out for 15 minutes after ten consecutive failures", async () => {
    const c = clock();
    h = await startHarness({}, { now: c.now });
    let failures = 0;
    while (failures < 10) {
      const res = await signIn(h, { username: USER, password: "wrong" });
      if (res.status === 429) {
        c.advance(Number(res.headers["retry-after"]) * 1000);
        continue;
      }
      expect(res.status).toBe(401);
      failures++;
    }
    const locked = await signIn(h, { username: USER, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.json()).toMatchObject({ error: "locked", retryAfter: 900 });
    expect(locked.json().message).toBe("Too many failed attempts. Sign-in from your network is paused for 15 minutes.");
    c.advance(15 * 60_000);
    expect((await signIn(h, { username: USER, password: PASSWORD })).status).toBe(200);
  });

  it("key on the address the proxy reports, and only the proxy", async () => {
    const c = clock();
    // The harness's loopback connection plays the proxy here.
    h = await startHarness({ trustedProxies: ["127.0.0.1"] }, { now: c.now });
    for (let i = 0; i < 5; i++) await signIn(h, { username: USER, password: "wrong" }, { "x-forwarded-for": "203.0.113.1" });
    expect((await signIn(h, { username: USER, password: PASSWORD }, { "x-forwarded-for": "203.0.113.1" })).status).toBe(429);
    expect((await signIn(h, { username: USER, password: PASSWORD }, { "x-forwarded-for": "203.0.113.2" })).status).toBe(200);
  });

  it("ignore a forwarding header from anyone but the proxy, so rotating it evades nothing", async () => {
    const c = clock();
    h = await startHarness({}, { now: c.now });
    for (let i = 0; i < 5; i++) await signIn(h, { username: USER, password: "wrong" }, { "x-forwarded-for": `198.51.100.${i}` });
    expect((await signIn(h, { username: USER, password: PASSWORD }, { "x-forwarded-for": "198.51.100.99" })).status).toBe(429);
  });
});

describe("sessions", () => {
  it("end after 12 idle hours unless remembered, and after 30 days regardless", async () => {
    const c = clock();
    h = await startHarness({}, { now: c.now });
    const plain = await login(h);
    const remembered = await login(h, { remember: true });
    c.advance(11 * 3600_000);
    expect(await authed(plain)("/")).toBe(200); // activity resets the idle clock
    c.advance(11 * 3600_000);
    expect(await authed(plain)("/")).toBe(200);
    c.advance(12 * 3600_000 + 1);
    expect(await authed(plain)("/")).toBe(401);
    expect(await authed(remembered)("/")).toBe(200);
    c.advance(30 * 24 * 3600_000);
    expect(await authed(remembered)("/")).toBe(401);
  });

  it("can be listed and ended — one, or all but this one", async () => {
    h = await startHarness();
    const a = await login(h);
    const b = await login(h);
    const d = await login(h);
    const list = (await request(h.base, "GET", "/_gate/sessions", { headers: { cookie: a } })).json<Array<{ id: string; current: boolean }>>();
    expect(list).toHaveLength(3);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    const bId = (await request(h.base, "GET", "/_gate/session", { headers: { cookie: b } })).json<{ id: string }>().id;

    const del = await request(h.base, "DELETE", `/_gate/sessions/${bId}`, { headers: sameOrigin(h, { cookie: a }) });
    expect(del.status).toBe(204);
    expect(await authed(b)("/")).toBe(401);
    expect(await authed(d)("/")).toBe(200);

    const others = await request(h.base, "DELETE", "/_gate/sessions?others=1", { headers: sameOrigin(h, { cookie: a }) });
    expect(others.json()).toEqual({ ended: 1 });
    expect(await authed(d)("/")).toBe(401);
    expect(await authed(a)("/")).toBe(200);
  });

  it("sign out ends the session and clears the cookie; another site cannot sign you out", async () => {
    h = await startHarness();
    const cookie = await login(h);
    const forged = await request(h.base, "POST", "/_gate/logout", { headers: { cookie, origin: "https://evil.example" } });
    expect(forged.status).toBe(403);
    expect(await authed(cookie)("/")).toBe(200);
    const res = await request(h.base, "POST", "/_gate/logout", { headers: sameOrigin(h, { cookie }) });
    expect(res.status).toBe(204);
    expect(res.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
    expect(await authed(cookie)("/")).toBe(401);
  });
});

describe("changing the password", () => {
  it("needs the current one, refuses a weak one, and ends every other session", async () => {
    const c = clock();
    h = await startHarness({}, { now: c.now });
    const mine = await login(h);
    const other = await login(h);
    const change = (body: object) => request(h!.base, "POST", "/_gate/password", { headers: sameOrigin(h!, { cookie: mine }), body });

    expect((await change({ current: "wrong", next: "a much better password" })).status).toBe(401);
    expect((await change({ current: PASSWORD, next: "short" })).status).toBe(400);
    expect((await change({ current: PASSWORD, next: "x".repeat(73) })).status).toBe(400);
    const ok = await change({ current: PASSWORD, next: "a much better password" });
    expect(ok.status).toBe(200);
    expect(ok.json()).toMatchObject({ endedSessions: 1 });
    expect(await authed(other)("/")).toBe(401);
    expect(await authed(mine)("/")).toBe(200);
    c.advance(60_000); // a fresh window of attempts
    expect((await signIn(h, { username: USER, password: PASSWORD })).status).toBe(401);
    expect((await signIn(h, { username: USER, password: "a much better password" })).status).toBe(200);
  });

  it("is refused to a device token", async () => {
    h = await startHarness();
    const { token } = await h.gate.core.auth.createToken("laptop");
    const res = await request(h.base, "POST", "/_gate/password", {
      headers: { authorization: `Bearer ${token}` },
      body: { current: PASSWORD, next: "whatever whatever" },
    });
    expect(res.status).toBe(403);
  });
});

describe("two-factor", () => {
  it("enrols, then asks for a code at sign-in, and each code works once", async () => {
    const c = clock();
    h = await startHarness({}, { now: c.now });
    const mine = await login(h);
    const other = await login(h);

    // Enrolling needs the password again, in the request.
    const unconfirmed = await request(h.base, "POST", "/_gate/totp/setup", { headers: sameOrigin(h, { cookie: mine }) });
    expect(unconfirmed.status).toBe(403);
    expect(unconfirmed.json()).toMatchObject({ error: "password_required" });
    const setup = await request(h.base, "POST", "/_gate/totp/setup", { headers: sameOrigin(h, { cookie: mine }), body: { password: PASSWORD } });
    expect(setup.status).toBe(200);
    const { secret, otpauthUrl, qrSvg } = setup.json<{ secret: string; otpauthUrl: string; qrSvg: string }>();
    expect(otpauthUrl).toContain(`secret=${secret}`);
    expect(qrSvg).toMatch(/^<svg/);

    const confirm = (code: string) =>
      request(h!.base, "POST", "/_gate/totp/confirm", { headers: sameOrigin(h!, { cookie: mine }), body: { code, password: PASSWORD } });
    expect((await confirm("000000")).status).toBe(400);
    const step = stepAt(c.now());
    const confirmed = await confirm(hotp(secret, step));
    expect(confirmed.status).toBe(200);
    const { recoveryCodes } = confirmed.json<{ recoveryCodes: string[] }>();
    expect(recoveryCodes).toHaveLength(10);
    // Turning two-factor on ends every other session.
    expect(await authed(other)("/")).toBe(401);
    expect(await authed(mine)("/")).toBe(200);

    c.advance(60_000); // a fresh window of attempts
    const noCode = await signIn(h, { username: USER, password: PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.json()).toMatchObject({ error: "code_required" });
    expect(noCode.headers["set-cookie"]).toBeUndefined();

    expect((await signIn(h, { username: USER, password: PASSWORD, code: "123456" })).json()).toMatchObject({ error: "invalid_code" });

    // A fresh code works once.
    const fresh = hotp(secret, stepAt(c.now()));
    expect((await signIn(h, { username: USER, password: PASSWORD, code: fresh })).status).toBe(200);
    const replayed = await signIn(h, { username: USER, password: PASSWORD, code: fresh });
    expect(replayed.status).toBe(401);
    expect(replayed.json()).toMatchObject({ error: "invalid_code" });

    c.advance(60_000);
    const recovery = recoveryCodes[0] as string;
    expect((await signIn(h, { username: USER, password: PASSWORD, code: recovery.toUpperCase() })).status).toBe(200);
    expect((await signIn(h, { username: USER, password: PASSWORD, code: recovery })).status).toBe(401);
    expect(h.gate.core.store.data.totp.recoveryCodes).toHaveLength(9);

    const info = await request(h.base, "GET", "/_gate/session", { headers: { cookie: mine } });
    expect(info.json()).toMatchObject({ twoFactor: true });
    // Enrolling again, credentials and all, is refused while it is on.
    const again = await request(h.base, "POST", "/_gate/totp/setup", {
      headers: sameOrigin(h, { cookie: mine }),
      body: { password: PASSWORD, code: hotp(secret, stepAt(c.now())) },
    });
    expect(again.status).toBe(409);
  });

  it("turns off only with the password and a code", async () => {
    const c = clock();
    h = await startHarness({}, { now: c.now });
    const mine = await login(h);
    const setup = await request(h.base, "POST", "/_gate/totp/setup", { headers: sameOrigin(h, { cookie: mine }), body: { password: PASSWORD } });
    const { secret } = setup.json<{ secret: string }>();
    await request(h.base, "POST", "/_gate/totp/confirm", {
      headers: sameOrigin(h, { cookie: mine }),
      body: { code: hotp(secret, stepAt(c.now())), password: PASSWORD },
    });
    // A step on, for a fresh code.
    c.advance(11 * 60_000);

    const off = (body: object) => request(h!.base, "DELETE", "/_gate/totp", { headers: sameOrigin(h!, { cookie: mine }), body });
    expect((await off({})).json()).toMatchObject({ error: "password_required", twoFactor: true });
    expect((await off({ password: "wrong" })).status).toBe(401);
    expect((await off({ password: PASSWORD })).json()).toMatchObject({ error: "code_required" });
    expect(h.gate.core.store.data.totp.secret).not.toBeNull();
    expect((await off({ password: PASSWORD, code: hotp(secret, stepAt(c.now())) })).status).toBe(204);
    expect(h.gate.core.store.data.totp.secret).toBeNull();
    c.advance(60_000);
    expect((await signIn(h, { username: USER, password: PASSWORD })).status).toBe(200);
  });

  it("the form post shows the code field when a code is needed", async () => {
    const c = clock();
    h = await startHarness({}, { now: c.now });
    const mine = await login(h);
    const { secret } = (
      await request(h.base, "POST", "/_gate/totp/setup", { headers: sameOrigin(h, { cookie: mine }), body: { password: PASSWORD } })
    ).json<{ secret: string }>();
    await request(h.base, "POST", "/_gate/totp/confirm", {
      headers: sameOrigin(h, { cookie: mine }),
      body: { code: hotp(secret, stepAt(c.now())), password: PASSWORD },
    });
    const res = await request(h.base, "POST", "/_gate/login", {
      headers: sameOrigin(h, { "content-type": "application/x-www-form-urlencoded" }),
      body: `username=${USER}&password=${encodeURIComponent(PASSWORD)}`,
    });
    expect(res.status).toBe(401);
    expect(res.body).toContain('id="code-field">');
    expect(res.body).toContain("Enter the 6-digit code");
  });
});
