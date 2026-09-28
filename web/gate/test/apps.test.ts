import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { EXPIRY_SWEEP_MS, MAX_REWRITE, decode } from "../src/app-access.js";
import { NAV, PAGE, grantFrom, registerApp, startPlane, type FakePlane } from "./app-helpers.js";
import { PASSWORD, login, openWs, request, sameOrigin, startHarness, type Harness } from "./helpers.js";

let plane: FakePlane;
let h: Harness;
let cookie: string;
let token: string;
let clock = Date.now();

beforeAll(async () => {
  plane = await startPlane();
  h = await startHarness({ dataPlane: { host: "127.0.0.1", port: plane.port } }, { now: () => clock });
  cookie = await login(h);
  const s = (await request(h.base, "POST", "/_gate/device/start", { body: { name: "cli" } })).json<{ deviceCode: string; userCode: string }>();
  await request(h.base, "POST", "/_gate/device/approve", { headers: sameOrigin(h, { cookie }), body: { userCode: s.userCode, password: PASSWORD } });
  token = (await request(h.base, "POST", "/_gate/device/poll", { body: { deviceCode: s.deviceCode } })).json<{ token: string }>().token;
});
afterAll(async () => {
  await h.close();
  await plane.close();
});
beforeEach(() => {
  h.gate.core.limiter.reset();
  h.gate.core.passcodes.reset();
});

const owner = () => sameOrigin(h, { cookie });
const bearer = () => ({ authorization: `Bearer ${token}` });

async function share(id: string, body: Record<string, unknown>) {
  return request(h.base, "PUT", `/_gate/apps/${id}/visibility`, { headers: owner(), body });
}

describe("the sandbox side (:7901)", () => {
  it("registers an app, always private and always the agent's", async () => {
    const app = await registerApp(h, { port: 5173, name: "goofy", cwd: "/workspace/goofy", command: "npm run dev" });
    expect(app).toMatchObject({ name: "goofy", port: 5173, createdBy: "agent", pinned: false, keepPrefix: false, compat: "auto" });
    expect(app.id).toMatch(/^[a-z2-7]{26}$/);
    expect(app.visibility).toEqual({ mode: "private", expiresAt: null });
    const list = (await request(h.apps, "GET", "/apps")).json<Array<{ id: string }>>();
    expect(list.some((a) => a.id === app.id)).toBe(true);
    expect((await request(h.apps, "GET", `/apps/${app.id}`)).json()).toMatchObject({ id: app.id });
  });

  it("refuses agentbox's own ports, at registration and on a change", async () => {
    for (const port of [8080, 7681, 7682, 7683, 7800, 7801, 7900, 7901, h.echoes.bridge.port]) {
      const res = await request(h.apps, "POST", "/apps", { body: { port } });
      expect(res.status, String(port)).toBe(400);
      expect(res.json()).toMatchObject({ error: "infrastructure_port" });
    }
    const app = await registerApp(h, { port: 5174 });
    const res = await request(h.apps, "PATCH", `/apps/${app.id}`, { body: { port: 7800 } });
    expect(res.status).toBe(400);
    expect((await request(h.apps, "GET", `/apps/${app.id}`)).json()).toMatchObject({ port: 5174 });
  });

  it("cannot touch visibility, in any form", async () => {
    const app = await registerApp(h, { port: 5175 });
    for (const body of [{ visibility: { mode: "link" } }, { passcode: "x" }, { createdBy: "owner" }]) {
      expect((await request(h.apps, "PATCH", `/apps/${app.id}`, { body })).status).toBe(400);
      expect((await request(h.apps, "POST", "/apps", { body: { port: 5176, ...body } })).status).toBe(400);
    }
    // There is no route for it here at all.
    expect((await request(h.apps, "PUT", `/apps/${app.id}/visibility`, { body: { mode: "link" } })).status).toBe(404);
    expect((await request(h.apps, "GET", `/apps/${app.id}`)).json()).toMatchObject({ visibility: { mode: "private" } });
  });

  it("changes and removes apps, and says when anything changed", async () => {
    const app = await registerApp(h, { port: 5177 });
    const { revision } = (await request(h.apps, "GET", "/apps/watch?wait=0")).json<{ revision: number }>();
    const waiting = request(h.apps, "GET", `/apps/watch?since=${revision}&wait=5000`);
    const patched = await request(h.apps, "PATCH", `/apps/${app.id}`, { body: { name: "renamed", pinned: true, compat: "off" } });
    expect(patched.json()).toMatchObject({ name: "renamed", pinned: true, compat: "off" });
    expect((await waiting).json()).toMatchObject({ revision: revision + 1, sharing: true });
    expect((await request(h.apps, "DELETE", `/apps/${app.id}`)).status).toBe(204);
    expect((await request(h.apps, "GET", `/apps/${app.id}`)).status).toBe(404);
  });

  it("checks what it is given", async () => {
    for (const body of [{}, { port: 0 }, { port: "x" }, { port: 5178, name: "" }, { port: 5178, cwd: "relative" }, { port: 5178, pinned: "yes" }, { port: 5178, compat: "maybe" }]) {
      expect((await request(h.apps, "POST", "/apps", { body })).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("the owner's side (/_gate/apps)", () => {
  it("lists apps and makes one of a port, for a session or a token", async () => {
    const created = await request(h.base, "POST", "/_gate/apps", { headers: owner(), body: { port: 3000, name: "mine" } });
    expect(created.status).toBe(201);
    expect(created.json()).toMatchObject({ createdBy: "owner", url: expect.stringMatching(/^\/a\/[a-z2-7]{26}\/$/) });
    const list = (await request(h.base, "GET", "/_gate/apps", { headers: bearer() })).json<{ sharing: boolean; apps: unknown[] }>();
    expect(list.sharing).toBe(true);
    expect(list.apps.length).toBeGreaterThan(0);
    expect((await request(h.base, "POST", "/_gate/apps", { headers: owner(), body: { port: 7800 } })).status).toBe(400);
  });

  it("is not open to anyone else, nor to another site", async () => {
    const app = await registerApp(h, { port: 5180 });
    expect((await request(h.base, "GET", "/_gate/apps")).status).toBe(401);
    // Refused whichever check comes first: no origin, and no session.
    expect([401, 403]).toContain((await request(h.base, "PUT", `/_gate/apps/${app.id}/visibility`, { body: { mode: "link" } })).status);
    expect((await request(h.base, "PUT", `/_gate/apps/${app.id}/visibility`, { headers: { origin: h.base }, body: { mode: "link" } })).status).toBe(401);
    const cross = await request(h.base, "PUT", `/_gate/apps/${app.id}/visibility`, { headers: { cookie, origin: "https://evil.example" }, body: { mode: "link" } });
    expect(cross.status).toBe(403);
  });

  it("checks the owner's choices", async () => {
    const app = await registerApp(h, { port: 5181 });
    for (const body of [{ mode: "public" }, { mode: "link", expiresIn: -1 }, { mode: "link", expiresIn: 10 ** 12 }, { mode: "passcode", passcode: "abc" }, { mode: "passcode", passcode: "seven77" }]) {
      expect((await share(app.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await share("abcdefghijklmnopqrstuvwxyz", { mode: "link" })).status).toBe(404);
  });
});

describe("who may open /a/<id>/", () => {
  it("nobody without a grant, a session or a token: a page load signs in, anything else is not found", async () => {
    const app = await registerApp(h, { port: 5200 });
    const before = plane.seen.length;
    const nav = await request(h.base, "GET", `/a/${app.id}/x?y=1`, { headers: NAV });
    expect(nav.status).toBe(302);
    expect(nav.headers.location).toBe(`/login?next=${encodeURIComponent(`/a/${app.id}/x?y=1`)}`);
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      expect((await request(h.base, method, `/a/${app.id}/api`)).status, method).toBe(404);
    }
    // An unknown id is answered the same way.
    expect((await request(h.base, "GET", "/a/abcdefghijklmnopqrstuvwxyz/", { headers: NAV })).status).toBe(302);
    expect((await request(h.base, "GET", "/a/abcdefghijklmnopqrstuvwxyz/api")).status).toBe(404);
    expect(plane.seen.length).toBe(before);
  });

  it("the owner, whose page load mints a grant that the page's own requests carry", async () => {
    const app = await registerApp(h, { port: 5201 });
    const res = await request(h.base, "GET", `/a/${app.id}/`, { headers: { cookie, ...NAV } });
    expect(res.status).toBe(200);
    const set = (res.headers["set-cookie"] ?? []).find((c) => c.startsWith("__Secure-agentbox-app="));
    expect(set).toMatch(new RegExp(`Path=/a/${app.id}/;`));
    for (const attr of ["HttpOnly", "Secure", "SameSite=None"]) expect(set).toContain(attr);
    const grant = grantFrom(res) as string;
    // What the opaque page itself sends: the grant, and Origin: null.
    const sub = await request(h.base, "GET", `/a/${app.id}/src/main.tsx`, { headers: { cookie: grant, origin: "null" } });
    expect(sub.status).toBe(200);
    expect(sub.headers["access-control-allow-origin"]).toBe("null");
    expect(sub.headers["access-control-allow-credentials"]).toBe("true");
    // Good for this app alone.
    const other = await registerApp(h, { port: 5202 });
    expect((await request(h.base, "GET", `/a/${other.id}/x`, { headers: { cookie: grant } })).status).toBe(404);
  });

  it("strips every front-door credential, and lets the app's own cookies through", async () => {
    const app = await registerApp(h, { port: 5203 });
    const res = await request(h.base, "GET", `/a/${app.id}/echo`, {
      headers: { cookie: `theme=dark; ${cookie}; __Secure-agentbox-app=junk; sid=1`, authorization: `Bearer ${token}` },
    });
    const seen = res.json<{ url: string; headers: Record<string, string> }>();
    expect(seen.url).toBe(`/app/5203/echo`);
    expect(seen.headers.cookie).toBe("theme=dark; sid=1");
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers["x-agentbox-prefix"]).toBe(`/a/${app.id}`);
  });

  it("a device token, with no grant minted for a script", async () => {
    const app = await registerApp(h, { port: 5204 });
    const res = await request(h.base, "GET", `/a/${app.id}/echo`, { headers: bearer() });
    expect(res.status).toBe(200);
    expect(grantFrom(res)).toBeNull();
  });

  it("a grant dies with the session it came from", async () => {
    const other = await login(h);
    const app = await registerApp(h, { port: 5205 });
    const grant = grantFrom(await request(h.base, "GET", `/a/${app.id}/`, { headers: { cookie: other, ...NAV } })) as string;
    expect((await request(h.base, "GET", `/a/${app.id}/x`, { headers: { cookie: grant } })).status).toBe(200);
    await request(h.base, "POST", "/_gate/logout", { headers: sameOrigin(h, { cookie: other }) });
    expect((await request(h.base, "GET", `/a/${app.id}/x`, { headers: { cookie: grant } })).status).toBe(404);
  });

  it("an owner's grant lasts an hour unused, and is renewed while the app is in use", async () => {
    const app = await registerApp(h, { port: 5214 });
    const first = grantFrom(await request(h.base, "GET", `/a/${app.id}/`, { headers: { cookie, ...NAV } })) as string;
    clock += 20 * 60_000;
    // Most of it left: no renewal.
    const early = await request(h.base, "GET", `/a/${app.id}/x`, { headers: { cookie: first } });
    expect(early.status).toBe(200);
    expect(grantFrom(early)).toBeNull();
    clock += 20 * 60_000;
    // Past half: the app's own request brings back a fresh one.
    const renewing = await request(h.base, "GET", `/a/${app.id}/x`, { headers: { cookie: first } });
    const second = grantFrom(renewing) as string;
    expect(second).toBeTruthy();
    expect(renewing.headers["set-cookie"]?.[0]).toContain("Max-Age=3600");
    clock += 40 * 60_000;
    // The first has run out; the renewed one has not.
    expect((await request(h.base, "GET", `/a/${app.id}/x`, { headers: { cookie: first } })).status).toBe(404);
    expect((await request(h.base, "GET", `/a/${app.id}/x`, { headers: { cookie: second } })).status).toBe(200);
    // Left alone for an hour, it is gone.
    clock += 61 * 60_000;
    expect((await request(h.base, "GET", `/a/${app.id}/x`, { headers: { cookie: second } })).status).toBe(404);
  });

  it("a forged or altered grant opens nothing", async () => {
    const app = await registerApp(h, { port: 5206 });
    const grant = grantFrom(await request(h.base, "GET", `/a/${app.id}/`, { headers: { cookie, ...NAV } })) as string;
    const value = grant.split("=")[1] as string;
    const parts = value.split(".");
    const forged = [
      `v1.${app.id}.p-0.zzzzzz.${parts[4]}`,
      [...parts.slice(0, 4), `${parts[4]}x`].join("."),
      `v1.${app.id}.s-deadbeef.${parts[3]}.${parts[4]}`,
      "garbage",
    ];
    for (const f of forged) expect((await request(h.base, "GET", `/a/${app.id}/x`, { headers: { cookie: `__Secure-agentbox-app=${f}` } })).status, f).toBe(404);
  });

  it("anyone, once the owner shares the link — until it is stopped", async () => {
    const app = await registerApp(h, { port: 5207 });
    const shared = await share(app.id, { mode: "link", expiresIn: 3600 });
    expect(shared.json()).toMatchObject({ visibility: { mode: "link", expiresAt: expect.any(Number) } });
    const res = await request(h.base, "GET", `/a/${app.id}/`, { headers: NAV });
    expect(res.status).toBe(200);
    expect(grantFrom(res)).toBeNull();
    expect((await request(h.base, "DELETE", `/_gate/apps/${app.id}/visibility`, { headers: owner() })).status).toBe(200);
    expect((await request(h.base, "GET", `/a/${app.id}/`, { headers: NAV })).status).toBe(302);
  });

  it("anyone with the passcode, which the gate alone ever sees", async () => {
    const app = await registerApp(h, { port: 5208 });
    expect((await share(app.id, { mode: "passcode", passcode: "open sesame", expiresIn: null })).status).toBe(200);
    // A page load gets the passcode page; a script gets nothing.
    const page = await request(h.base, "GET", `/a/${app.id}/deep/page?q=1`, { headers: NAV });
    expect(page.status).toBe(200);
    expect(page.body).toContain(`action="/a/${app.id}/__agentbox/unlock"`);
    expect(page.body).toContain(`value="/a/${app.id}/deep/page?q=1"`);
    expect(String(page.headers["content-security-policy"])).toContain("sandbox");
    expect((await request(h.base, "GET", `/a/${app.id}/api`)).status).toBe(404);

    const before = plane.seen.length;
    const form = (passcode: string) =>
      request(h.base, "POST", `/a/${app.id}/__agentbox/unlock`, {
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "null" },
        body: `passcode=${encodeURIComponent(passcode)}&next=${encodeURIComponent(`/a/${app.id}/deep/page?q=1`)}`,
      });
    const wrong = await form("nope");
    expect(wrong.status).toBe(401);
    expect(wrong.body).toContain("isn’t right");
    const right = await form("open sesame");
    expect(right.status).toBe(303);
    expect(right.headers.location).toBe(`/a/${app.id}/deep/page?q=1`);
    // The passcode never reached the app.
    expect(plane.seen.length).toBe(before);
    const grant = grantFrom(right) as string;
    expect((await request(h.base, "GET", `/a/${app.id}/api`, { headers: { cookie: grant } })).status).toBe(200);

    // A new passcode voids what the old one unlocked.
    await share(app.id, { mode: "passcode", passcode: "new passcode", expiresIn: null });
    expect((await request(h.base, "GET", `/a/${app.id}/api`, { headers: { cookie: grant } })).status).toBe(404);
  });

  it("makes a passcode when the owner asks for one without giving it, and hands it back once", async () => {
    const app = await registerApp(h, { port: 5215 });
    const res = await share(app.id, { mode: "passcode", expiresIn: null });
    expect(res.status).toBe(200);
    const made = res.json<{ passcode: string }>().passcode;
    expect(made).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    // Shared again without one: the passcode is kept, and not handed back.
    const again = await share(app.id, { mode: "passcode", expiresIn: 3600 });
    expect(again.json()).not.toHaveProperty("passcode");
    const unlocked = await request(h.base, "POST", `/a/${app.id}/__agentbox/unlock`, {
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "null" },
      body: `passcode=${made}`,
    });
    expect(unlocked.status).toBe(303);
  });

  it("takes a passcode from the app's own page, never another site's form", async () => {
    const app = await registerApp(h, { port: 5212 });
    await share(app.id, { mode: "passcode", passcode: "letmein-now", expiresIn: null });
    const res = await request(h.base, "POST", `/a/${app.id}/__agentbox/unlock`, {
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: "passcode=letmein-now",
    });
    expect(res.status).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("keeps guesses at a passcode off the owner's sign-in budget, locks out the guesser, and caps them per app from everywhere", async () => {
    let tclock = Date.now();
    const t = await startHarness({ trustedProxies: ["127.0.0.1"], dataPlane: { host: "127.0.0.1", port: plane.port } }, { now: () => tclock });
    try {
      const c = await login(t);
      const created = await request(t.apps, "POST", "/apps", { body: { port: 5213 } });
      const id = created.json<{ id: string }>().id;
      await request(t.base, "PUT", `/_gate/apps/${id}/visibility`, { headers: sameOrigin(t, { cookie: c }), body: { mode: "passcode", passcode: "right one!", expiresIn: null } });
      const guess = (ip: string, passcode = "wrong") =>
        request(t.base, "POST", `/a/${id}/__agentbox/unlock`, {
          headers: { "content-type": "application/x-www-form-urlencoded", origin: "null", "x-agentbox-client-ip": ip },
          body: `passcode=${encodeURIComponent(passcode)}`,
        });
      // One address: five guesses, then it waits — and signs in all the same.
      for (let i = 0; i < 5; i++) expect((await guess("198.51.100.1")).status).toBe(401);
      expect((await guess("198.51.100.1")).status).toBe(429);
      await login(t, { ip: "198.51.100.1" });
      // It keeps at it until it is locked out; that locks out it alone, and
      // a visitor with the passcode is let in all the same.
      for (let n = 0; n < 5; n++) {
        tclock += 70_000;
        await guess("198.51.100.1");
      }
      expect((await guess("198.51.100.1", "right one!")).status).toBe(429);
      expect((await guess("198.51.100.9", "right one!")).status).toBe(303);
      // Many addresses, each within its own limits: two hundred wrong
      // passcodes for the app within ten minutes, and nobody gets another
      // try for a while — the right passcode included. (A fresh window first.)
      tclock += 11 * 60_000;
      for (let i = 0; i < 200; i++) {
        if (i % 25 === 0) tclock += 61_000;
        expect((await guess(`203.0.${Math.floor(i / 250)}.${(i % 250) + 1}`)).status, String(i)).toBe(401);
      }
      const capped = await guess("203.0.113.250", "right one!");
      expect(capped.status).toBe(429);
      expect(capped.body).toContain("Too many wrong passcodes for this app");
    } finally {
      await t.close();
    }
  });

  it("sends a passcode's visitor only somewhere in the app", async () => {
    const app = await registerApp(h, { port: 5209 });
    await share(app.id, { mode: "passcode", passcode: "letmein-now", expiresIn: null });
    for (const next of ["https://evil.example/", "//evil.example", "/vscode/", `/a/${app.id}/../../x`, "/a/abcdefghijklmnopqrstuvwxyz/"]) {
      const res = await request(h.base, "POST", `/a/${app.id}/__agentbox/unlock`, {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `passcode=letmein-now&next=${encodeURIComponent(next)}`,
      });
      expect(res.headers.location, next).toBe(`/a/${app.id}/`);
    }
  });

  it("serves a private app's fonts without a grant, and nothing else", async () => {
    const app = await registerApp(h, { port: 5210 });
    const font = await request(h.base, "GET", `/a/${app.id}/assets/font.woff2`, { headers: { origin: "null" } });
    expect(font.status).toBe(200);
    expect(font.headers["content-type"]).toBe("font/woff2");
    expect((await request(h.base, "GET", `/a/${app.id}/assets/notfont.woff2`)).status).toBe(404);
    expect((await request(h.base, "GET", "/a/abcdefghijklmnopqrstuvwxyz/font.woff2")).status).toBe(404);
    expect((await request(h.base, "POST", `/a/${app.id}/assets/font.woff2`)).status).toBe(404);
  });

  it("never serves an app on agentbox's own ports, even one registered before they were", async () => {
    const app = await registerApp(h, { port: 5211 });
    // Stand in for a record written before the port was infrastructure.
    const rec = h.gate.core.apps.get(app.id);
    if (rec) rec.port = 7800;
    expect((await request(h.base, "GET", `/a/${app.id}/`, { headers: { cookie } })).status).toBe(404);
  });

  it("gives an address that keeps guessing a 429", async () => {
    const ip = { "x-agentbox-client-ip": "198.51.100.77" };
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await request(h.base, "GET", "/a/abcdefghijklmnopqrstuvwxyz/x", { headers: ip })).status;
    expect(last).toBe(429);
  });
});

describe("the app policy", () => {
  it("sandboxes every answer, and scopes an app's cookies and redirects to it", async () => {
    const app = await registerApp(h, { port: 5300 });
    const res = await request(h.base, "POST", `/a/${app.id}/login`, { headers: { cookie, origin: "null" }, body: "u=1" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/a/${app.id}/dashboard`);
    expect(res.headers["set-cookie"]).toEqual([`sid=s3cret; Path=/a/${app.id}/; HttpOnly; Secure; SameSite=None`]);
    expect(String(res.headers["content-security-policy"])).toContain("sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads");
    const away = await request(h.base, "GET", `/a/${app.id}/away`, { headers: { cookie } });
    expect(away.headers.location).toBe(`/a/${app.id}/landed`);
    const hostile = await request(h.base, "GET", `/a/${app.id}/hostile`, { headers: { cookie } });
    for (const n of ["clear-site-data", "strict-transport-security", "service-worker-allowed"]) expect(hostile.headers[n], n).toBeUndefined();
    // The gate's own refusals are sandboxed too.
    expect(String((await request(h.base, "GET", `/a/${app.id}/x`)).headers["content-security-policy"])).toContain("sandbox");
  });

  it("answers the app's own preflights itself, for any id", async () => {
    const before = plane.seen.length;
    const res = await request(h.base, "OPTIONS", "/a/abcdefghijklmnopqrstuvwxyz/api", {
      headers: { origin: "null", "access-control-request-method": "PUT", "access-control-request-headers": "content-type" },
    });
    expect(res.status).toBe(204);
    expect(res.headers).toMatchObject({ "access-control-allow-origin": "null", "access-control-allow-methods": "PUT", "access-control-allow-headers": "content-type" });
    expect(plane.seen.length).toBe(before);
  });

  it("refuses a change another site asks for", async () => {
    const app = await registerApp(h, { port: 5301 });
    const grant = grantFrom(await request(h.base, "GET", `/a/${app.id}/`, { headers: { cookie, ...NAV } })) as string;
    expect((await request(h.base, "POST", `/a/${app.id}/api`, { headers: { cookie: grant, origin: "https://evil.example" }, body: "x" })).status).toBe(403);
    expect((await request(h.base, "POST", `/a/${app.id}/api`, { headers: { cookie: grant, origin: "null" }, body: "x" })).status).toBe(200);
  });

  it("forwards the full path to an app started with its base path", async () => {
    const app = await registerApp(h, { port: 5302, keepPrefix: true });
    const res = await request(h.base, "GET", `/a/${app.id}/src/x.ts?t=1`, { headers: { cookie } });
    expect(res.json()).toMatchObject({ url: `/app/5302/a/${app.id}/src/x.ts?t=1` });
  });

  it("passes an app's own path through exactly as sent", async () => {
    const app = await registerApp(h, { port: 5303 });
    const res = await request(h.base, "GET", `/a/${app.id}/api/pkg/@scope%2fname;v=1`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ url: `/app/5303/api/pkg/@scope%2fname;v=1` });
  });
});

describe("path fidelity", () => {
  it("rewrites a page for its prefix, and asks for it uncompressed", async () => {
    const app = await registerApp(h, { port: 5400 });
    const res = await request(h.base, "GET", `/a/${app.id}/`, { headers: { cookie, ...NAV, "accept-encoding": "gzip, br" } });
    expect(res.body).toContain(`<script src="/a/${app.id}/__agentbox/shim.js"></script><script type="importmap">`);
    expect(res.body).toContain(`src="/a/${app.id}/src/main.tsx" crossorigin="use-credentials"`);
    expect(res.body).toContain(`<img src="/a/${app.id}/logo.png">`);
    expect(Number(res.headers["content-length"])).toBe(Buffer.byteLength(res.body));
    expect(plane.seen[plane.seen.length - 1]?.headers["accept-encoding"]).toBe("identity");
    // The app's validator named its own bytes, not these.
    expect(res.headers.etag).toBeUndefined();
  });

  it("reads a compressed page to rewrite it", async () => {
    const app = await registerApp(h, { port: 5401 });
    const res = await request(h.base, "GET", `/a/${app.id}/gz.html`, { headers: { cookie } });
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body).toContain(`/a/${app.id}/__agentbox/shim.js`);
  });

  it("never decodes more than it will hold: a compression bomb goes on as it came", async () => {
    const app = await registerApp(h, { port: 5405 });
    const before = process.memoryUsage().rss;
    const res = await request(h.base, "GET", `/a/${app.id}/bomb.html`, { headers: { cookie, ...NAV, "accept-encoding": "gzip" } });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(process.memoryUsage().rss - before).toBeLessThan(64 * 1024 * 1024);
    expect(decode(zlib.gzipSync(Buffer.alloc(MAX_REWRITE + 1, 0x20)), "gzip")).toBeNull();
    expect(decode(zlib.brotliCompressSync(Buffer.alloc(MAX_REWRITE + 1, 0x20)), "br")).toBeNull();
    expect(decode(zlib.deflateSync(Buffer.alloc(MAX_REWRITE + 1, 0x20)), "deflate")).toBeNull();
    expect(decode(zlib.gzipSync(Buffer.from("<p>fine</p>")), "gzip")?.toString()).toBe("<p>fine</p>");
  });

  it("rewrites CSS, and serves the shim", async () => {
    const app = await registerApp(h, { port: 5402 });
    expect((await request(h.base, "GET", `/a/${app.id}/style.css`, { headers: { cookie } })).body).toBe(`body{background:url(/a/${app.id}/bg.png)}`);
    const shim = await request(h.base, "GET", `/a/${app.id}/__agentbox/shim.js`, { headers: { cookie } });
    expect(shim.status).toBe(200);
    expect(shim.headers["content-type"]).toContain("javascript");
    expect(shim.body).toContain(`var P = "/a/${app.id}"`);
  });

  it("marks a page it could not fully fix", async () => {
    const app = await registerApp(h, { port: 5403 });
    const res = await request(h.base, "GET", `/a/${app.id}/own-map.html`, { headers: { cookie } });
    expect(res.headers["x-agentbox-hint"]).toBe("root-absolute");
  });

  it("leaves a page alone with the path fixes off", async () => {
    const app = await registerApp(h, { port: 5404, compat: "off" });
    const res = await request(h.base, "GET", `/a/${app.id}/`, { headers: { cookie, ...NAV } });
    expect(res.body).toBe(PAGE);
  });
});

describe("taking access away cuts what it let in", () => {
  function openStream(path: string, headers: Record<string, string>): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: h.port, path, headers, agent: false }, resolve);
      req.on("error", reject);
    });
  }
  function closed(res: http.IncomingMessage): Promise<void> {
    return new Promise((resolve) => {
      res.on("close", () => resolve());
      res.resume();
    });
  }

  it("stopping sharing cuts a connected visitor, and leaves the owner connected", async () => {
    const app = await registerApp(h, { port: 5500 });
    await share(app.id, { mode: "link", expiresIn: null });
    const visitor = await openStream(`/a/${app.id}/events`, {});
    const mine = await openStream(`/a/${app.id}/events`, { cookie });
    expect(visitor.statusCode).toBe(200);
    expect(h.gate.apps.openCount(app.id)).toBe(2);
    const cut = closed(visitor);
    await request(h.base, "DELETE", `/_gate/apps/${app.id}/visibility`, { headers: owner() });
    await cut;
    expect(h.gate.apps.openCount(app.id)).toBe(1);
    mine.destroy();
  });

  it("a visitor's WebSocket is cut too", async () => {
    const app = await registerApp(h, { port: 5501 });
    await share(app.id, { mode: "link", expiresIn: null });
    const res = await openWs(`ws://127.0.0.1:${h.port}/a/${app.id}/hmr`, { origin: "null" });
    if (!("ws" in res)) throw new Error(`no socket: ${JSON.stringify(res)}`);
    const gone = new Promise<void>((r) => res.ws.once("close", () => r()));
    await request(h.base, "DELETE", `/_gate/apps/${app.id}/visibility`, { headers: owner() });
    await gone;
  });

  it("links expire, and expired links are cut", async () => {
    const app = await registerApp(h, { port: 5502 });
    await share(app.id, { mode: "link", expiresIn: 60 });
    const visitor = await openStream(`/a/${app.id}/events`, {});
    const cut = closed(visitor);
    clock += 61_000;
    // Judged at once for new requests…
    expect((await request(h.base, "GET", `/a/${app.id}/`, { headers: NAV })).status).toBe(302);
    // …and by the sweep for open ones.
    await h.gate.core.apps.expire();
    await cut;
    expect((await request(h.base, "GET", "/_gate/apps", { headers: bearer() })).json<{ apps: Array<{ id: string; visibility: { mode: string } }> }>().apps.find((a) => a.id === app.id)?.visibility.mode).toBe("private");
    expect(EXPIRY_SWEEP_MS).toBe(30_000);
  });

  it("removing an app cuts everyone, the owner included", async () => {
    const app = await registerApp(h, { port: 5503 });
    const mine = await openStream(`/a/${app.id}/events`, { cookie });
    const cut = closed(mine);
    await request(h.apps, "DELETE", `/apps/${app.id}`);
    await cut;
  });
});

describe("an app's WebSockets", () => {
  it("open from the app's own page or the box, never another site", async () => {
    const app = await registerApp(h, { port: 5600 });
    const grant = grantFrom(await request(h.base, "GET", `/a/${app.id}/`, { headers: { cookie, ...NAV } })) as string;
    const ok = await openWs(`ws://127.0.0.1:${h.port}/a/${app.id}/?token=x`, { cookie: grant, origin: "null" }, ["vite-hmr"]);
    if (!("ws" in ok)) throw new Error(`refused: ${JSON.stringify(ok)}`);
    expect(ok.first.url).toBe("/app/5600/?token=x");
    const seenHeaders = ok.first.headers as Record<string, string>;
    expect(seenHeaders.cookie).toBeUndefined();
    ok.ws.close();
    expect(await openWs(`ws://127.0.0.1:${h.port}/a/${app.id}/`, { cookie: grant, origin: "https://evil.example" })).toEqual({ status: 403 });
    expect(await openWs(`ws://127.0.0.1:${h.port}/a/${app.id}/`, { origin: "null" })).toEqual({ status: 404 });
  });
});

describe("tunnels", () => {
  it("take a device token, and nothing else", async () => {
    expect(await openWs(`ws://127.0.0.1:${h.port}/_gate/tunnel?target=tcp:5173`, {})).toEqual({ status: 401 });
    expect(await openWs(`ws://127.0.0.1:${h.port}/_gate/tunnel?target=tcp:5173`, { cookie, origin: h.base })).toEqual({ status: 401 });
    expect(await openWs(`ws://127.0.0.1:${h.port}/_gate/tunnel?target=tcp:99999`, bearer())).toEqual({ status: 400 });
    expect(await openWs(`ws://127.0.0.1:${h.port}/_gate/tunnel?target=unix:/x`, bearer())).toEqual({ status: 400 });
    expect((await request(h.base, "GET", "/_gate/tunnel?target=tcp:5173", { headers: bearer() })).status).toBe(426);
  });

  it("reach any port, agentbox's own included, and herdr, on the data plane", async () => {
    for (const [target, path] of [
      ["tcp:5173", "/tunnel/tcp/5173"],
      ["tcp:8080", "/tunnel/tcp/8080"],
      ["herdr", "/tunnel/herdr"],
    ]) {
      const res = await openWs(`ws://127.0.0.1:${h.port}/_gate/tunnel?target=${target}`, bearer());
      if (!("ws" in res)) throw new Error(`${target}: ${JSON.stringify(res)}`);
      expect(res.first.url).toBe(path);
      expect((res.first.headers as Record<string, string>).authorization).toBeUndefined();
      res.ws.close();
    }
  });
});

describe("with sharing turned off", () => {
  it("nothing can be made public, and what was public is private again", async () => {
    const app = await registerApp(h, { port: 5700 });
    await share(app.id, { mode: "link", expiresIn: null });
    // A copy of this store, opened by a gate with sharing off.
    await h.gate.core.store.flush();
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "gate-sharing-off-"));
    fs.copyFileSync(path.join(h.dataDir, "gate.json"), path.join(copy, "gate.json"));
    const off = await startHarness({ dataDir: copy, sharing: false, dataPlane: { host: "127.0.0.1", port: plane.port } });
    try {
      const c = await login(off);
      expect(off.gate.core.apps.get(app.id)?.visibility.mode).toBe("private");
      const res = await request(off.base, "PUT", `/_gate/apps/${app.id}/visibility`, { headers: sameOrigin(off, { cookie: c }), body: { mode: "link" } });
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({ error: "sharing_off" });
      expect((await request(off.base, "GET", "/_gate/apps", { headers: { cookie: c } })).json()).toMatchObject({ sharing: false });
      // And for good: the store says so, so sharing turned back on opens nothing.
      await off.gate.core.store.flush();
      const saved = JSON.parse(fs.readFileSync(path.join(copy, "gate.json"), "utf8")) as { apps: Array<{ id: string; visibility: { mode: string } }> };
      expect(saved.apps.find((a) => a.id === app.id)?.visibility.mode).toBe("private");
    } finally {
      await off.close();
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });
});
