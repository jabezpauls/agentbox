import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppRegistry, isAppId, newAppId } from "../src/apps.js";
import { Store } from "../src/store.js";

const dirs: string[] = [];
function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-apps-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("app ids", () => {
  it("are 26 characters of lowercase base32", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newAppId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(isAppId(id), id).toBe(true);
    expect(isAppId("ABCDEFGHIJKLMNOPQRSTUVWXYZ")).toBe(false);
    expect(isAppId("abc")).toBe(false);
  });
});

describe("the registry", () => {
  it("makes every shared app private for good when sharing is turned off", async () => {
    const dir = scratch();
    const store = await Store.open(dir, null);
    const on = new AppRegistry(store, { infraPorts: [], sharing: true });
    const app = await on.create({ port: 5173 }, "agent");
    await on.setVisibility(app.id, { mode: "link", expiresAt: null });
    await store.flush();

    // A gate started with --sharing off, on the same store, and nothing else.
    const again = await Store.open(dir, null);
    const off = new AppRegistry(again, { infraPorts: [], sharing: false });
    expect(off.get(app.id)?.visibility.mode).toBe("private");
    await again.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "gate.json"), "utf8")) as { apps: Array<{ visibility: { mode: string } }> };
    expect(saved.apps[0]?.visibility.mode).toBe("private");
  });

  it("judges a link's expiry when asked, not only when swept", async () => {
    let now = 1_000_000;
    const store = await Store.open(scratch(), null);
    const reg = new AppRegistry(store, { infraPorts: [], sharing: true, now: () => now });
    const app = await reg.create({ port: 5173 }, "owner");
    await reg.setVisibility(app.id, { mode: "link", expiresAt: now + 1000 });
    expect(reg.isPublic(app)).toBe("link");
    now += 1001;
    expect(reg.isPublic(app)).toBeNull();
    expect(await reg.expire()).toBe(1);
    expect(app.visibility.mode).toBe("private");
  });

  it("voids a passcode's grants when the passcode changes, and only then", async () => {
    const store = await Store.open(scratch(), null);
    const reg = new AppRegistry(store, { infraPorts: [], sharing: true });
    const app = await reg.create({ port: 5173 }, "owner");
    await reg.setVisibility(app.id, { mode: "passcode", expiresAt: null, passcodeHash: "h1" });
    const epoch = app.visibility.epoch;
    await reg.setVisibility(app.id, { mode: "passcode", expiresAt: 5 });
    expect(app.visibility.epoch).toBe(epoch);
    expect(app.visibility.passcodeHash).toBe("h1");
    await reg.setVisibility(app.id, { mode: "passcode", expiresAt: null, passcodeHash: "h2" });
    expect(app.visibility.epoch).toBe(epoch + 1);
  });
});
