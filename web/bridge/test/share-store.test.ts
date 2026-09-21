import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_TTL_MS, ShareStore, TOKEN_PATTERN, ID_PATTERN } from "../src/share/store.js";

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "shares-"));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("ShareStore", () => {
  it("mints an unguessable, live share and resolves its token to the port", async () => {
    const store = new ShareStore(dir);
    const share = await store.create(3000);
    expect(share.port).toBe(3000);
    expect(share.token).toMatch(TOKEN_PATTERN);
    expect(share.id).toMatch(ID_PATTERN);
    expect(await store.resolve(share.token)).toBe(3000);
  });

  it("does not resolve an unknown or malformed token", async () => {
    const store = new ShareStore(dir);
    await store.create(3000);
    expect(await store.resolve("0".repeat(32))).toBeNull();
    expect(await store.resolve("not-a-token")).toBeNull();
    expect(await store.resolve("")).toBeNull();
  });

  it("revokes a share so its token 404s immediately", async () => {
    const store = new ShareStore(dir);
    const share = await store.create(3000);
    expect(await store.revoke(share.id)).toBe(true);
    expect(await store.resolve(share.token)).toBeNull();
    // A second revoke finds nothing live.
    expect(await store.revoke(share.id)).toBe(false);
  });

  it("stops resolving once a share has expired", async () => {
    const store = new ShareStore(dir);
    const share = await store.create(3000);
    // Rewrite the persisted record with an expiry in the past.
    const file = path.join(dir, "shares.json");
    const rows = JSON.parse(await fsp.readFile(file, "utf8")) as { expires: string }[];
    rows[0]!.expires = new Date(Date.now() - 1000).toISOString();
    await fsp.writeFile(file, JSON.stringify(rows));
    const fresh = new ShareStore(dir);
    expect(await fresh.resolve(share.token)).toBeNull();
  });

  it("extends a share's expiry", async () => {
    const store = new ShareStore(dir);
    const share = await store.create(3000);
    const before = Date.parse(share.expires);
    const extended = await store.extend(share.id);
    expect(extended).not.toBeNull();
    expect(Date.parse(extended!.expires)).toBeGreaterThanOrEqual(before);
    // Within the default window of now.
    expect(Date.parse(extended!.expires) - Date.now()).toBeLessThanOrEqual(DEFAULT_TTL_MS + 1000);
  });

  it("survives a restart by reloading the persisted file", async () => {
    const first = new ShareStore(dir);
    const share = await first.create(4321);
    const second = new ShareStore(dir);
    expect(await second.resolve(share.token)).toBe(4321);
    const list = await second.list();
    expect(list.map((s) => s.port)).toContain(4321);
  });

  it("prunes expired and revoked entries out of the list", async () => {
    const store = new ShareStore(dir);
    const keep = await store.create(3000);
    const gone = await store.create(3001);
    await store.revoke(gone.id);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(keep.id);
    // The revoked record is gone from disk, not merely hidden.
    const rows = JSON.parse(await fsp.readFile(path.join(dir, "shares.json"), "utf8")) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it("writes the store file with owner-only permissions", async () => {
    const store = new ShareStore(dir);
    await store.create(3000);
    const mode = fs.statSync(path.join(dir, "shares.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
