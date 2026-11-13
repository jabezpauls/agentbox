import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { signedUpdatesOnly } from "../src/commands/update.js";
import { EXIT } from "../src/errors.js";
import { RELEASE_PUBLIC_KEYS } from "../src/node/release-keys.js";
import { checkForUpdate, describeReport, MANIFEST_FILE, RELEASES_URL, SIGNATURE_FILE, type UpdateOptions } from "../src/node/update.js";
import { compareVersions, machinePlatform, parseVersion, UpdateRefused, verifyManifest } from "../src/node/update-verify.js";
import { runCli, signedIn, tmpDir } from "./helpers.js";

// Key pairs made for this run alone: no private key is ever in the repository.
const pair = (): { pub: string; priv: crypto.KeyObject } => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ type: "spki", format: "pem" }).toString(), priv: privateKey };
};
const release = pair();
const next = pair();
const stranger = pair();

const sha = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");
const sign = (bytes: Buffer, key: crypto.KeyObject): string => `${crypto.sign(null, bytes, key).toString("base64")}\n`;

const NODE_BIN = Buffer.from("#!/bin/sh\necho 'agentbox v1.3.0'\n");
const HERDR_BIN = Buffer.from("herdr 0.9.4");
const CLAUDE_BIN = Buffer.from("claude 2.1.400");
const A = "https://example.invalid/assets";

function manifest(version = "v1.3.0", over: { node?: Buffer } = {}): Buffer {
  const entry = {
    node: { url: `${A}/agentbox-linux-x64`, sha256: sha(over.node ?? NODE_BIN), size: (over.node ?? NODE_BIN).length },
    herdr: { version: "0.9.4", url: `${A}/herdr`, sha256: sha(HERDR_BIN) },
    claude: { version: "2.1.400", url: `${A}/claude`, sha256: sha(CLAUDE_BIN) },
  };
  return Buffer.from(JSON.stringify({ schema: 1, version, platforms: { "linux-x64": entry } }, null, 2));
}

/** A stand-in for GitHub: what each URL answers (absent: 404), and which were asked for. */
function releases(files: Record<string, Buffer | string>): { fetch: typeof globalThis.fetch; asked: string[] } {
  const asked: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const body = files[url];
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(typeof body === "string" ? body : new Uint8Array(body));
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

function served(m: Buffer, sig: string | null, binaries: Record<string, Buffer> = {}): Record<string, Buffer | string> {
  return {
    [`${RELEASES_URL}/${MANIFEST_FILE}`]: m,
    ...(sig === null ? {} : { [`${RELEASES_URL}/${SIGNATURE_FILE}`]: sig }),
    [`${A}/agentbox-linux-x64`]: NODE_BIN,
    [`${A}/herdr`]: HERDR_BIN,
    [`${A}/claude`]: CLAUDE_BIN,
    ...binaries,
  };
}

/** A node folder with a running node v1.2.0 and herdr and Claude Code installed. */
function machine(): { dir: string; node: string; herdr: string; claude: string } {
  const dir = tmpDir("agentbox-node-update-");
  const node = path.join(dir, "agentbox");
  const herdr = path.join(dir, "herdr");
  const claude = path.join(dir, "claude");
  fs.writeFileSync(node, "old node");
  fs.writeFileSync(herdr, "old herdr");
  fs.writeFileSync(claude, "old claude");
  return { dir, node, herdr, claude };
}

function options(m: ReturnType<typeof machine>, fetch: typeof globalThis.fetch, over: Partial<UpdateOptions> = {}): UpdateOptions {
  return {
    policy: "auto",
    running: "v1.2.0",
    nodePath: m.node,
    herdr: { path: m.herdr, version: "0.9.3" },
    claude: { path: m.claude, version: "2.1.311" },
    idle: () => true,
    platform: "linux",
    arch: "x64",
    keys: [release.pub, next.pub],
    fetch,
    checkRuns: () => {},
    ...over,
  };
}

const untouched = (m: ReturnType<typeof machine>): void => {
  expect(fs.readFileSync(m.node, "utf8")).toBe("old node");
  expect(fs.readFileSync(m.herdr, "utf8")).toBe("old herdr");
  expect(fs.readFileSync(m.claude, "utf8")).toBe("old claude");
  // Nothing half-downloaded left behind.
  expect(fs.readdirSync(m.dir).sort()).toEqual(["agentbox", "claude", "herdr"]);
};

describe("a machine's node updates from signed releases only", () => {
  it("applies a newer release signed by a built-in key: the node, then herdr and Claude Code when idle", async () => {
    const m = machine();
    const mf = manifest();
    const { fetch } = releases(served(mf, sign(mf, release.priv)));
    const report = await checkForUpdate(options(m, fetch));
    expect(report).toEqual({ state: "updated", version: "v1.3.0", from: "v1.2.0", restart: true, tools: { herdr: "updated", claude: "updated" } });
    expect(fs.readFileSync(m.node)).toEqual(NODE_BIN);
    expect(fs.readFileSync(m.herdr)).toEqual(HERDR_BIN);
    expect(fs.readFileSync(m.claude)).toEqual(CLAUDE_BIN);
    expect(fs.statSync(m.node).mode & 0o111).not.toBe(0);
    expect(describeReport(report)).toMatch(/updated agentbox v1\.2\.0 → v1\.3\.0, restarting; herdr updated; Claude Code updated/);
  });

  it("takes the next key as well, so the key can be rotated", async () => {
    const m = machine();
    const mf = manifest();
    const { fetch } = releases(served(mf, sign(mf, next.priv)));
    expect((await checkForUpdate(options(m, fetch))).state).toBe("updated");
  });

  it("refuses a binary that does not match the signed manifest, and leaves the old one", async () => {
    const m = machine();
    const mf = manifest();
    const tampered = Buffer.from(NODE_BIN.toString().replace("1.3.0", "6.6.6"));
    const { fetch } = releases(served(mf, sign(mf, release.priv), { [`${A}/agentbox-linux-x64`]: tampered }));
    await expect(checkForUpdate(options(m, fetch))).rejects.toThrow(/does not match the signed manifest/);
    untouched(m);
  });

  it("refuses an unsigned manifest", async () => {
    const m = machine();
    const mf = manifest();
    for (const sig of [null, "", "not a signature\n"]) {
      const { fetch, asked } = releases(served(mf, sig));
      await expect(checkForUpdate(options(m, fetch))).rejects.toThrow(/not signed/);
      expect(asked.some((u) => u.startsWith(A))).toBe(false);
    }
    untouched(m);
  });

  it("refuses a manifest signed by a key it was not built with", async () => {
    const m = machine();
    const mf = manifest();
    const { fetch, asked } = releases(served(mf, sign(mf, stranger.priv)));
    await expect(checkForUpdate(options(m, fetch))).rejects.toThrow(/not signed by a release key this node trusts/);
    expect(asked.some((u) => u.startsWith(A))).toBe(false);
    untouched(m);
  });

  it("refuses a manifest changed after it was signed", async () => {
    const m = machine();
    const evil = Buffer.from("#!/bin/sh\necho evil\n");
    const signed = manifest();
    const changed = manifest("v1.3.0", { node: evil });
    const { fetch } = releases(served(changed, sign(signed, release.priv), { [`${A}/agentbox-linux-x64`]: evil }));
    await expect(checkForUpdate(options(m, fetch))).rejects.toBeInstanceOf(UpdateRefused);
    untouched(m);
  });

  it("refuses an older signed release (no rollback), and takes nothing from it", async () => {
    const m = machine();
    const mf = manifest("v1.1.9");
    const { fetch, asked } = releases(served(mf, sign(mf, release.priv)));
    await expect(checkForUpdate(options(m, fetch))).rejects.toThrow(/older than this node.*not going back/);
    expect(asked.some((u) => u.startsWith(A))).toBe(false);
    untouched(m);
  });

  it("does not reinstall the version it runs", async () => {
    const m = machine();
    const mf = manifest("v1.2.0");
    const { fetch, asked } = releases(served(mf, sign(mf, release.priv)));
    const report = await checkForUpdate(options(m, fetch, { herdr: { path: m.herdr, version: "0.9.4" }, claude: { path: m.claude, version: "2.1.400" } }));
    expect(report).toEqual({ state: "current", version: "v1.2.0", tools: { herdr: "current", claude: "current" } });
    expect(asked.some((u) => u.startsWith(A))).toBe(false);
    untouched(m);
  });

  it("refuses everything when no release key is built in, without fetching", async () => {
    expect(RELEASE_PUBLIC_KEYS.every((k) => k.includes("BEGIN PUBLIC KEY"))).toBe(true);
    const m = machine();
    const mf = manifest();
    const { fetch, asked } = releases(served(mf, sign(mf, release.priv)));
    await expect(checkForUpdate(options(m, fetch, { keys: [] }))).rejects.toThrow(/no release keys built in/);
    expect(asked).toEqual([]);
    untouched(m);
  });

  it("updates: notify says what is available; off fetches nothing", async () => {
    const m = machine();
    const mf = manifest();
    const { fetch, asked } = releases(served(mf, sign(mf, release.priv)));
    const r = await checkForUpdate(options(m, fetch, { policy: "notify" }));
    expect(r).toEqual({ state: "available", version: "v1.3.0", from: "v1.2.0" });
    expect(describeReport(r)).toMatch(/available/);
    untouched(m);
    asked.length = 0;
    expect(await checkForUpdate(options(m, fetch, { policy: "off" }))).toEqual({ state: "off" });
    expect(asked).toEqual([]);
  });

  it("replaces herdr and Claude Code only once no agent runs", async () => {
    const m = machine();
    const mf = manifest();
    const { fetch } = releases(served(mf, sign(mf, release.priv)));
    const busy = await checkForUpdate(options(m, fetch, { idle: () => false }));
    expect(busy).toMatchObject({ state: "updated", tools: { herdr: "deferred", claude: "deferred" } });
    expect(fs.readFileSync(m.herdr, "utf8")).toBe("old herdr");
    // The next check, from the node now running v1.3.0, once idle.
    const later = await checkForUpdate(options(m, fetch, { running: "v1.3.0", idle: async () => true }));
    expect(later).toEqual({ state: "current", version: "v1.3.0", tools: { herdr: "updated", claude: "updated" } });
    expect(fs.readFileSync(m.herdr)).toEqual(HERDR_BIN);
  });

  it("does not install a node that does not start", async () => {
    const m = machine();
    const mf = manifest();
    const { fetch } = releases(served(mf, sign(mf, release.priv)));
    const checkRuns = (): void => {
      throw new UpdateRefused("the downloaded agentbox does not run here");
    };
    await expect(checkForUpdate(options(m, fetch, { checkRuns }))).rejects.toThrow(/does not run here/);
    untouched(m);
  });

  it("knows versions and platforms", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("0.0.0-dev")).toBeNull();
    expect(compareVersions([1, 10, 0], [1, 9, 9])).toBeGreaterThan(0);
    expect(machinePlatform("win32", "x64")).toBe("win-x64");
    expect(machinePlatform("darwin", "arm64")).toBeNull();
    expect(() => verifyManifest(manifest(), sign(manifest(), release.priv), [release.pub])).not.toThrow();
  });
});

describe("the box-served update on a machine with a node", () => {
  it("is refused, pointing to signed releases", async () => {
    const home = tmpDir("agentbox-home-");
    expect(signedUpdatesOnly({ HOME: home }, "linux", false)).toBeNull();
    fs.mkdirSync(path.join(home, ".local", "share", "agentbox", "node"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local", "share", "agentbox", "node", "credentials.json"), "{}");
    expect(signedUpdatesOnly({ HOME: home }, "linux", false)).toMatch(/joined to a box as a node .*signed releases/);
    const r = await runCli(["update"], { configDir: signedIn("https://box.example.invalid"), env: { HOME: home } });
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.stderr).toMatch(/updates only from signed releases, never from a box/);
  });

  it("finds the node's folder on Windows, and is refused in the standalone executable", () => {
    const local = tmpDir("agentbox-localappdata-");
    expect(signedUpdatesOnly({ LOCALAPPDATA: local }, "win32", false)).toBeNull();
    fs.mkdirSync(path.join(local, "agentbox", "node"), { recursive: true });
    fs.writeFileSync(path.join(local, "agentbox", "node", "credentials.json"), "{}");
    expect(signedUpdatesOnly({ LOCALAPPDATA: local }, "win32", false)).toMatch(/node/);
    expect(signedUpdatesOnly({ HOME: tmpDir() }, "linux", true)).toMatch(/standalone agentbox/);
  });
});
