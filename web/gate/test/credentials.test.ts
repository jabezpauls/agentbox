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

const as = (hh: Harness, cookie: string, method: string, path: string, body: object = {}) =>
  request(hh.base, method, path, { headers: sameOrigin(hh, { cookie }), body });

describe("sensitive account changes", () => {
  it("need the password in the request itself: having typed it once lends a same-session script nothing", async () => {
    h = await startHarness();
    const cookie = await login(h);
    const { token } = await h.gate.core.auth.createToken("existing laptop");
    const tokenId = h.gate.core.store.data.tokens[0]?.id as string;

    // The owner approves their own CLI, typing the password as the page asks.
    const own = (await request(h.base, "POST", "/_gate/device/start", { body: { name: "my laptop" } })).json<{ userCode: string }>();
    expect((await as(h, cookie, "POST", "/_gate/device/approve", { userCode: own.userCode, password: PASSWORD })).status).toBe(200);

    // Script served by a compromised sandbox, in the same session straight
    // afterwards: nothing is open, and every one of these is refused.
    const session = (await request(h.base, "GET", "/_gate/session", { headers: { cookie } })).json();
    expect(session).not.toHaveProperty("sudoUntil");
    const evil = (await request(h.base, "POST", "/_gate/device/start", { body: { name: "agentbox CLI" } })).json<{ userCode: string }>();
    const attempts: Array<[string, string, object]> = [
      ["POST", "/_gate/device/approve", { userCode: evil.userCode }],
      ["POST", "/_gate/totp/setup", {}],
      ["POST", "/_gate/totp/confirm", { code: "123456" }],
      ["DELETE", "/_gate/totp", {}],
      ["POST", "/_gate/password", { next: "attacker-chosen-password" }],
      ["DELETE", `/_gate/tokens/${tokenId}`, {}],
    ];
    for (const [method, path, body] of attempts) {
      const res = await as(h, cookie, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.json(), `${method} ${path}`).toMatchObject({ error: "password_required" });
    }
    // Nothing changed: the owner's password and token still work, no new token.
    expect(h.gate.core.store.data.tokens).toHaveLength(2);
    expect((await request(h.base, "GET", "/", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect(h.gate.core.store.data.totp.pending).toBeNull();
    const again = await request(h.base, "POST", "/_gate/login", { headers: sameOrigin(h), body: { username: USER, password: PASSWORD } });
    expect(again.status).toBe(200);
  });

  it("there is no endpoint that opens a window", async () => {
    h = await startHarness();
    const cookie = await login(h);
    const res = await as(h, cookie, "POST", "/_gate/sudo", { password: PASSWORD });
    expect(res.status).toBe(404);
  });

  it("want the password each time, not once per few minutes", async () => {
    h = await startHarness();
    const cookie = await login(h);
    const a = await h.gate.core.auth.createToken("a");
    const b = await h.gate.core.auth.createToken("b");
    expect((await as(h, cookie, "DELETE", `/_gate/tokens/${a.record.id}`, { password: PASSWORD })).status).toBe(204);
    // Straight after: the next one needs it again.
    expect((await as(h, cookie, "DELETE", `/_gate/tokens/${b.record.id}`)).status).toBe(403);
    expect((await as(h, cookie, "DELETE", `/_gate/tokens/${b.record.id}`, { password: PASSWORD })).status).toBe(204);
  });

  it("the password change needs the current password, always", async () => {
    h = await startHarness();
    const cookie = await login(h);
    expect((await as(h, cookie, "POST", "/_gate/password", { next: "a new password here" })).json()).toMatchObject({
      error: "password_required",
    });
    const wrong = await as(h, cookie, "POST", "/_gate/password", { current: "wrong password", next: "a new password here" });
    expect(wrong.status).toBe(401);
    expect(wrong.json()).toMatchObject({ message: "The current password is not right." });
    expect((await as(h, cookie, "POST", "/_gate/password", { current: PASSWORD, next: "a new password here" })).status).toBe(200);
  });

  it("with two-factor on, want a code as well as the password", async () => {
    const c = clock();
    h = await startHarness({}, { now: c.now });
    const cookie = await login(h);
    const { secret } = (await as(h, cookie, "POST", "/_gate/totp/setup", { password: PASSWORD })).json<{ secret: string }>();
    expect((await as(h, cookie, "POST", "/_gate/totp/confirm", { code: hotp(secret, stepAt(c.now())), password: PASSWORD })).status).toBe(200);
    c.advance(60_000);
    const tok = await h.gate.core.auth.createToken("x");
    const noCode = await as(h, cookie, "DELETE", `/_gate/tokens/${tok.record.id}`, { password: PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.json()).toMatchObject({ error: "code_required", twoFactor: true });
    const ok = await as(h, cookie, "DELETE", `/_gate/tokens/${tok.record.id}`, { password: PASSWORD, code: hotp(secret, stepAt(c.now())) });
    expect(ok.status).toBe(204);
  });

  it("count against the sign-in limits, before bcrypt", async () => {
    h = await startHarness();
    const cookie = await login(h);
    const tok = await h.gate.core.auth.createToken("x");
    for (let i = 0; i < 4; i++) {
      expect((await as(h, cookie, "DELETE", `/_gate/tokens/${tok.record.id}`, { password: `wrong-${i}` })).status).toBe(401);
    }
    expect((await as(h, cookie, "DELETE", `/_gate/tokens/${tok.record.id}`, { password: PASSWORD })).status).toBe(429);
  });

  it("are a browser session's alone: a device token cannot make them", async () => {
    h = await startHarness();
    const { token } = await h.gate.core.auth.createToken("laptop");
    const res = await request(h.base, "POST", "/_gate/totp/setup", { headers: { authorization: `Bearer ${token}` }, body: { password: PASSWORD } });
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ error: "session_required" });
  });

  it("leave ordinary use alone", async () => {
    h = await startHarness();
    const cookie = await login(h);
    const start = (await request(h.base, "POST", "/_gate/device/start", { body: { name: "cli" } })).json<{ userCode: string }>();
    expect((await request(h.base, "GET", "/workbench/api/health", { headers: { cookie } })).status).toBe(200);
    expect((await request(h.base, "GET", "/_gate/sessions", { headers: { cookie } })).status).toBe(200);
    expect((await as(h, cookie, "DELETE", "/_gate/sessions?others=1")).status).toBe(200);
    expect((await as(h, cookie, "POST", "/_gate/device/deny", { userCode: start.userCode })).status).toBe(200);
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
