import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { callAdmin, runAdmin, startAdminServer } from "../src/admin.js";
import { Auth } from "../src/auth.js";
import { runCli } from "../src/cli.js";
import { holdLease, LEASE_FILE } from "../src/lease.js";
import { Store } from "../src/store.js";
import { COST, PASSWORD, USER, login, openWs, request, sameOrigin, startHarness, type Harness } from "./helpers.js";

let h: Harness | null = null;
let admin: Server | null = null;
afterEach(async () => {
  admin?.close();
  admin = null;
  await h?.close();
  h = null;
});

async function withAdmin(): Promise<Harness> {
  h = await startHarness();
  const { core } = h.gate;
  admin = await startAdminServer(core.config.adminSocket, {
    config: core.config,
    store: core.store,
    auth: core.auth,
    devices: core.devices,
    limiter: core.limiter,
    now: core.now,
  });
  return h;
}

describe("the host's admin commands", () => {
  it("set-password goes through the running gate and ends every session", async () => {
    const hh = await withAdmin();
    const cookie = await login(hh);
    const out = await callAdmin(hh.gate.core.config.adminSocket, "set-password", { password: "brand new password" });
    expect(out).toMatchObject({ status: 200, body: { ok: true, endedSessions: 1 } });
    // The new hash comes back so the host can keep .env's seed in step.
    expect(String(out?.body.hash)).toMatch(/^\$2[aby]\$\d\d\$/);
    expect(hh.gate.core.store.data.password?.hash).toBe(out?.body.hash);
    expect((await request(hh.base, "GET", "/", { headers: { cookie } })).status).toBe(401);
    const res = await request(hh.base, "POST", "/_gate/login", { headers: sameOrigin(hh), body: { username: USER, password: "brand new password" } });
    expect(res.status).toBe(200);
  });

  it("set-password refuses a password bcrypt would truncate or that is too short", async () => {
    const hh = await withAdmin();
    expect((await callAdmin(hh.gate.core.config.adminSocket, "set-password", { password: "short" }))?.status).toBe(400);
    expect((await callAdmin(hh.gate.core.config.adminSocket, "set-password", { password: "é".repeat(40) }))?.status).toBe(400);
  });

  it("unlock clears a lockout, and totp-reset turns two-factor off", async () => {
    const hh = await withAdmin();
    for (let i = 0; i < 5; i++) {
      await request(hh.base, "POST", "/_gate/login", { headers: sameOrigin(hh), body: { username: USER, password: "wrong" } });
    }
    const locked = await request(hh.base, "POST", "/_gate/login", { headers: sameOrigin(hh), body: { username: USER, password: PASSWORD } });
    expect(locked.status).toBe(429);
    await callAdmin(hh.gate.core.config.adminSocket, "unlock");
    hh.gate.core.store.data.totp.secret = "JBSWY3DPEHPK3PXP";
    const out = await callAdmin(hh.gate.core.config.adminSocket, "totp-reset");
    expect(out?.status).toBe(200);
    expect(hh.gate.core.store.data.totp.secret).toBeNull();
    const ok = await request(hh.base, "POST", "/_gate/login", { headers: sameOrigin(hh), body: { username: USER, password: PASSWORD } });
    expect(ok.status).toBe(200);
  });

  it("revoke-all ends every session and every token", async () => {
    const hh = await withAdmin();
    const cookie = await login(hh);
    const { token } = await hh.gate.core.auth.createToken("laptop");
    const out = await callAdmin(hh.gate.core.config.adminSocket, "revoke-all");
    expect(out?.body).toEqual({ ok: true, endedSessions: 1, revokedTokens: 1 });
    expect((await request(hh.base, "GET", "/", { headers: { cookie } })).status).toBe(401);
    expect((await request(hh.base, "GET", "/", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("a sign-in that checked the old password while it changed does not survive the change", async () => {
    h = await startHarness();
    const core = h.gate.core;
    // bcrypt at cost 14 takes about a second; stand in for that.
    const verify = core.passwords.verify.bind(core.passwords);
    core.passwords.verify = async (p, s) => {
      const ok = await verify(p, s);
      await new Promise((r) => setTimeout(r, 300));
      return ok;
    };
    const attempt = request(h.base, "POST", "/_gate/login", { headers: sameOrigin(h), body: { username: USER, password: PASSWORD } });
    await new Promise((r) => setTimeout(r, 100));
    await runAdmin({ config: core.config, store: core.store, auth: core.auth, now: Date.now }, "set-password", { password: "a brand new password" });
    const res = await attempt;
    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(core.auth.listSessions()).toEqual([]);
  });

  it("revoke-all cuts a terminal whose session had already gone idle and been pruned", async () => {
    let t = Date.now();
    h = await startHarness({}, { now: () => t });
    const cookie = await login(h);
    const opened = await openWs(`ws://127.0.0.1:${h.port}/terminal/ws`, { cookie, origin: h.base });
    if (!("ws" in opened)) throw new Error(`upgrade refused: ${opened.status}`);
    const closed = new Promise<void>((r) => opened.ws.once("close", () => r()));
    // Away for 13 hours, the terminal tab left open and silent: the prune ends
    // the session, and with it the terminal.
    t += 13 * 3600_000;
    await h.gate.core.auth.prune();
    await closed;
    expect(h.gate.core.auth.listSessions()).toEqual([]);
  });

  it("revoke-all and a password change cut every socket but the kept session's", async () => {
    const hh = await withAdmin();
    const open = async (cookie: string) => {
      const o = await openWs(`ws://127.0.0.1:${hh.port}/terminal/ws`, { cookie, origin: hh.base });
      if (!("ws" in o)) throw new Error(`upgrade refused: ${o.status}`);
      return o.ws;
    };
    const closed = (ws: import("ws").WebSocket) => new Promise<void>((r) => ws.once("close", () => r()));
    const a = await open(await login(hh));
    const aClosed = closed(a);
    await callAdmin(hh.gate.core.config.adminSocket, "revoke-all");
    await aClosed;

    const mine = await login(hh);
    const b = await open(await login(hh));
    const kept = await open(mine);
    const bClosed = closed(b);
    const res = await request(hh.base, "POST", "/_gate/password", {
      headers: sameOrigin(hh, { cookie: mine }),
      body: { current: PASSWORD, next: "an entirely new one" },
    });
    expect(res.status).toBe(200);
    await bClosed;
    expect(kept.readyState).toBe(kept.OPEN);
    kept.close();
  });

  it("--offline refuses while any gate holds the store, in any container", async () => {
    h = await startHarness();
    const io = { config: h.gate.core.config, readPassword: async () => "whatever whatever" };
    // No lease: a stopped stack, so the store is edited directly.
    expect(JSON.parse(await runCli(["--offline", "status"], io))).toMatchObject({ passwordSet: true });
    // A running gate elsewhere holds the lease on the volume.
    const release = holdLease(h.dataDir);
    try {
      await expect(runCli(["--offline", "set-password"], io)).rejects.toThrow(/a gate is running on this store/);
    } finally {
      release();
    }
    // A lease left by a gate that died long ago does not block.
    fs.writeFileSync(path.join(h.dataDir, LEASE_FILE), JSON.stringify({ host: "gone", pid: 1, at: Date.now() - 60_000 }));
    expect(JSON.parse(await runCli(["--offline", "status"], io))).toMatchObject({ passwordSet: true });
  });

  it("reports that no gate is listening, so the command can edit the store itself", async () => {
    h = await startHarness();
    expect(await callAdmin(`${h.dataDir}/nothing.sock`, "status")).toBeNull();
    // Offline, against the store on disk.
    const store = await Store.open(h.dataDir, null);
    const out = await runAdmin(
      { config: { ...h.gate.core.config, bcryptCost: COST }, store, auth: new Auth(store), now: Date.now },
      "status",
    );
    expect(out).toMatchObject({ passwordSet: true, twoFactor: false });
  });
});
