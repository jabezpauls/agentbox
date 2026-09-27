import { afterEach, describe, expect, it } from "vitest";
import { hotp, stepAt } from "../src/totp.js";
import { PASSWORD, USER, login, request, sameOrigin, startHarness, type Harness } from "./helpers.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function clock(start = 1_750_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const post = (hh: Harness, path: string, cookie: string, body: object = {}) =>
  request(hh.base, "POST", path, { headers: sameOrigin(hh, { cookie }), body });

describe("sudo mode", () => {
  it("is granted by the password for ten minutes, and the session says until when", async () => {
    const c = clock();
    h = await startHarness({}, { now: c.now });
    const cookie = await login(h);
    const session = () => request(h!.base, "GET", "/_gate/session", { headers: { cookie } }).then((r) => r.json());
    expect(await session()).toMatchObject({ sudoUntil: null });

    expect((await post(h, "/_gate/sudo", cookie, { password: "wrong" })).status).toBe(401);
    const granted = await post(h, "/_gate/sudo", cookie, { password: PASSWORD });
    expect(granted.status).toBe(200);
    expect(granted.json()).toEqual({ sudoUntil: c.now() + 10 * 60_000 });
    expect(await session()).toMatchObject({ sudoUntil: c.now() + 10 * 60_000 });

    // Within the window a sensitive request needs nothing more.
    expect((await post(h, "/_gate/totp/setup", cookie)).status).toBe(200);
    c.advance(10 * 60_000);
    expect((await post(h, "/_gate/totp/setup", cookie)).json()).toMatchObject({ error: "sudo_required" });
  });

  it("checks credentials sent with a request even in sudo mode: a wrong one fails it", async () => {
    h = await startHarness();
    const cookie = await login(h);
    await post(h, "/_gate/sudo", cookie, { password: PASSWORD });
    const res = await post(h, "/_gate/password", cookie, { current: "wrong password", next: "a new password here" });
    expect(res.status).toBe(401);
    expect(res.json()).toMatchObject({ message: "The current password is not right." });
    // In sudo mode the current password may be left out.
    expect((await post(h, "/_gate/password", cookie, { next: "a new password here" })).status).toBe(200);
  });

  it("with two-factor on, needs a code as well as the password", async () => {
    const c = clock();
    h = await startHarness({}, { now: c.now });
    const cookie = await login(h);
    const { secret } = (await post(h, "/_gate/totp/setup", cookie, { password: PASSWORD })).json<{ secret: string }>();
    await post(h, "/_gate/totp/confirm", cookie, { code: hotp(secret, stepAt(c.now())) });
    c.advance(11 * 60_000);
    const noCode = await post(h, "/_gate/sudo", cookie, { password: PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.json()).toMatchObject({ error: "code_required", twoFactor: true });
    const ok = await post(h, "/_gate/sudo", cookie, { password: PASSWORD, code: hotp(secret, stepAt(c.now())) });
    expect(ok.status).toBe(200);
  });

  it("counts against the sign-in limits, before bcrypt", async () => {
    h = await startHarness();
    const cookie = await login(h);
    for (let i = 0; i < 4; i++) expect((await post(h, "/_gate/sudo", cookie, { password: `wrong-${i}` })).status).toBe(401);
    const res = await post(h, "/_gate/sudo", cookie, { password: PASSWORD });
    expect(res.status).toBe(429);
  });

  it("is a browser session's alone: a device token cannot enter it", async () => {
    h = await startHarness();
    const { token } = await h.gate.core.auth.createToken("laptop");
    const res = await request(h.base, "POST", "/_gate/sudo", { headers: { authorization: `Bearer ${token}` }, body: { password: PASSWORD } });
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ error: "session_required" });
  });

  it("guards exactly the account changes, not ordinary use", async () => {
    h = await startHarness();
    const cookie = await login(h);
    const { token } = await h.gate.core.auth.createToken("x");
    const tokens = (await request(h.base, "GET", "/_gate/tokens", { headers: { cookie } })).json<Array<{ id: string }>>();
    const start = (await request(h.base, "POST", "/_gate/device/start", { body: { name: "cli" } })).json<{ userCode: string }>();
    const sensitive: Array<[string, string, object]> = [
      ["POST", "/_gate/password", { next: "a new password here" }],
      ["POST", "/_gate/totp/setup", {}],
      ["POST", "/_gate/totp/confirm", { code: "123456" }],
      ["DELETE", "/_gate/totp", {}],
      ["POST", "/_gate/device/approve", { userCode: start.userCode }],
      ["DELETE", `/_gate/tokens/${tokens[0]?.id}`, {}],
    ];
    for (const [method, path, body] of sensitive) {
      const res = await request(h.base, method, path, { headers: sameOrigin(h, { cookie }), body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.json(), `${method} ${path}`).toMatchObject({ error: "sudo_required" });
    }
    // Ordinary use needs no password again.
    expect((await request(h.base, "GET", "/workbench/api/health", { headers: { cookie } })).status).toBe(200);
    expect((await request(h.base, "GET", "/_gate/sessions", { headers: { cookie } })).status).toBe(200);
    expect((await request(h.base, "DELETE", "/_gate/sessions?others=1", { headers: sameOrigin(h, { cookie }) })).status).toBe(200);
    expect((await post(h, "/_gate/device/deny", cookie, { userCode: start.userCode })).status).toBe(200);
    expect((await request(h.base, "GET", "/", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });
});

describe("IPv6 clients", () => {
  it("share one sign-in budget per /64", async () => {
    h = await startHarness({ trustedProxies: ["127.0.0.1"] });
    const attempt = (ip: string, password = "wrong") =>
      request(h!.base, "POST", "/_gate/login", {
        headers: sameOrigin(h!, { "x-agentbox-client-ip": ip }),
        body: { username: USER, password },
      });
    // Five addresses of one /64, one guess each...
    for (let i = 1; i <= 5; i++) expect((await attempt(`2001:db8:aa:bb::${i}`)).status).toBe(401);
    // ...and the sixth address of that /64 has no budget left.
    expect((await attempt("2001:db8:aa:bb::6", PASSWORD)).status).toBe(429);
    // Another /64 is another client.
    expect((await attempt("2001:db8:aa:bc::1", PASSWORD)).status).toBe(200);
  });
});
