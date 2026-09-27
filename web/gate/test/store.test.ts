import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STORE_FILE, STORE_VERSION, Store, StoreError, isBcryptHash } from "../src/store.js";
import { seed } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-store-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const file = () => path.join(dir, STORE_FILE);
const onDisk = () => JSON.parse(fs.readFileSync(file(), "utf8")) as Record<string, unknown>;

describe("the store", () => {
  it("is created on first open, versioned, private, with every collection present", async () => {
    await Store.open(dir, null);
    const data = onDisk();
    expect(data.version).toBe(STORE_VERSION);
    for (const k of ["sessions", "deviceCodes", "tokens", "apps"]) expect(data[k]).toEqual([]);
    expect(data.password).toBeNull();
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("takes the password from the seed only when it has none", async () => {
    const hash = await seed();
    const s = await Store.open(dir, hash, 42);
    expect(s.data.password).toEqual({ hash, updatedAt: 42 });

    // The store is the source of truth: a different seed later changes nothing.
    s.data.password = { hash: "$2b$04$" + "a".repeat(53), updatedAt: 43 };
    await s.save();
    const again = await Store.open(dir, hash, 44);
    expect(again.data.password?.updatedAt).toBe(43);
  });

  it("ignores a seed that is not a bcrypt hash", async () => {
    const s = await Store.open(dir, "plaintext-password");
    expect(s.data.password).toBeNull();
  });

  it("recognises the bcrypt variants Caddy, Go and Node write", async () => {
    const tail = (await seed()).slice(7);
    expect(tail).toHaveLength(53);
    expect(isBcryptHash(`$2a$14$${tail}`)).toBe(true);
    expect(isBcryptHash(`$2b$10$${tail}`)).toBe(true);
    expect(isBcryptHash(`$2y$10$${tail}`)).toBe(true);
    expect(isBcryptHash(`$2a$14$${tail}x`)).toBe(false);
    expect(isBcryptHash("")).toBe(false);
  });

  it("refuses to start over a corrupt file rather than overwrite it", async () => {
    fs.writeFileSync(file(), "{ not json");
    await expect(Store.open(dir, await seed())).rejects.toBeInstanceOf(StoreError);
    expect(fs.readFileSync(file(), "utf8")).toBe("{ not json");
  });

  it("refuses a file written by a newer gate", async () => {
    fs.writeFileSync(file(), JSON.stringify({ version: STORE_VERSION + 1 }));
    await expect(Store.open(dir, null)).rejects.toThrow(/schema v2/);
  });

  it("folds concurrent saves into writes that each include every change", async () => {
    const s = await Store.open(dir, null);
    const saves: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      s.data.apps.push({ i });
      saves.push(s.save());
    }
    await Promise.all(saves);
    expect((onDisk().apps as unknown[]).length).toBe(20);
    // No temporary files are left behind.
    expect(fs.readdirSync(dir)).toEqual([STORE_FILE]);
  });

  it("flushes a deferred save on demand", async () => {
    const s = await Store.open(dir, null);
    s.data.apps.push({ deferred: true });
    s.saveSoon(60_000);
    expect((onDisk().apps as unknown[]).length).toBe(0);
    await s.flush();
    expect((onDisk().apps as unknown[]).length).toBe(1);
  });

  it("exposes the app registry for later phases", async () => {
    const s = await Store.open(dir, null);
    expect(s.apps).toBe(s.data.apps);
  });
});
