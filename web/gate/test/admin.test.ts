import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { callAdmin, runAdmin, startAdminServer } from "../src/admin.js";
import { Auth } from "../src/auth.js";
import { Store } from "../src/store.js";
import { COST, PASSWORD, USER, login, request, sameOrigin, startHarness, type Harness } from "./helpers.js";

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
    expect(out).toEqual({ status: 200, body: { ok: true, endedSessions: 1 } });
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
