import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { unpackVerified } from "./install.js";
import { RELEASE_PUBLIC_KEYS } from "./release-keys.js";
import {
  compareVersions,
  machinePlatform,
  parseVersion,
  UpdateRefused,
  verifyManifest,
  type Asset,
  type Manifest,
  type MachinePlatform,
  type VersionedAsset,
} from "./update-verify.js";

/**
 * A machine's node updates itself from signed GitHub releases only, never
 * from the box (the box cannot choose what runs on a machine):
 *
 * 1. the manifest and its signature come from the latest GitHub release;
 * 2. the signature must verify against a key built into this node;
 * 3. a version not newer than the one running is not taken (no rollback);
 * 4. each file is downloaded beside the one it replaces, its SHA-256 checked
 *    against the manifest, and renamed over it in one step.
 *
 * The node itself is replaced at once (the caller restarts it); herdr and
 * Claude Code only when no agent is running (`idle`), else at a later check.
 */

export type UpdatePolicy = "auto" | "notify" | "off";

/** Where the latest release's files are downloaded from. */
export const RELEASES_URL = "https://github.com/jabezpauls/agentbox/releases/latest/download";
export const MANIFEST_FILE = "machines-manifest.json";
export const SIGNATURE_FILE = "machines-manifest.json.sig";

const MAX_MANIFEST = 256 * 1024;
const MAX_SIGNATURE = 4 * 1024;
/** Claude Code alone is about 300 MB. */
const MAX_ASSET = 1024 * 1024 * 1024;

/** A tool the node keeps in its `bin/`: where it is, and which version is there (`null`: none yet). */
export interface Installed {
  path: string;
  version: string | null;
  /** Where the version is noted (Claude Code's `bin/claude.version`), rewritten on update. */
  versionFile?: string;
}

export interface UpdateOptions {
  /** policy.json's `updates` (read by the caller). */
  policy: UpdatePolicy;
  /** The version this node runs (VERSION). */
  running: string;
  /** The executable to replace; `null` when this node is not the standalone one (agentbox.mjs under Node). */
  nodePath: string | null;
  /** Windows: agentbox-node.exe, the windowless copy, replaced with it. */
  nodeGuiPath?: string;
  herdr?: Installed;
  claude?: Installed;
  /** No agent is running, so herdr and Claude Code may be replaced now. */
  idle?: () => boolean | Promise<boolean>;
  /** Test seams. */
  platform?: NodeJS.Platform;
  arch?: string;
  keys?: readonly string[];
  fetch?: typeof globalThis.fetch;
  releasesUrl?: string;
  /** Checks a downloaded node starts and says this version; the default runs `<file> --version`. */
  checkRuns?: (file: string, version: string) => void;
}

export type ComponentState = "updated" | "current" | "deferred" | "unsupported" | "none";

export type UpdateReport =
  /** `updates: off`: nothing was fetched. */
  | { state: "off" }
  /** Nothing newer than what runs; `tools` says what happened to herdr and Claude Code. */
  | { state: "current"; version: string; tools: ToolsReport }
  /** `updates: notify`: a newer release exists, and is not applied. */
  | { state: "available"; version: string; from: string }
  /** Applied: the node was replaced and must be restarted (`restart`). */
  | { state: "updated"; version: string; from: string; restart: boolean; tools: ToolsReport };

export interface ToolsReport {
  herdr: ComponentState;
  claude: ComponentState;
}

/** One line for the log and `status`. */
export function describeReport(r: UpdateReport): string {
  const tools = (t: ToolsReport): string =>
    [t.herdr === "deferred" || t.claude === "deferred" ? "herdr and Claude Code are updated once no agent is running" : "", t.herdr === "updated" ? "herdr updated" : "", t.claude === "updated" ? "Claude Code updated" : ""]
      .filter(Boolean)
      .join("; ");
  switch (r.state) {
    case "off":
      return "updates are off (policy.json)";
    case "current": {
      const t = tools(r.tools);
      return `up to date (agentbox ${r.version})${t ? `; ${t}` : ""}`;
    }
    case "available":
      return `agentbox ${r.version} is available (this is ${r.from}); updates are set to notify, so run it by hand or set "updates": "auto"`;
    case "updated": {
      const t = tools(r.tools);
      return `updated agentbox ${r.from} → ${r.version}${r.restart ? ", restarting" : ""}${t ? `; ${t}` : ""}`;
    }
  }
}

async function fetchLimited(fetcher: typeof globalThis.fetch, url: string, max: number, what: string): Promise<Buffer | null> {
  const res = await fetcher(url, { redirect: "follow" });
  if (res.status === 404) return null;
  if (!res.ok || !res.body) throw new Error(`${what}: HTTP ${res.status} from ${url}`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += c.length;
    if (size > max) throw new UpdateRefused(`${what} is larger than any real one; not updating`);
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

/** The latest release's manifest, verified. Throws UpdateRefused for anything not signed by a trusted key. */
export async function fetchManifest(o: Pick<UpdateOptions, "keys" | "fetch" | "releasesUrl"> = {}): Promise<Manifest> {
  const keys = o.keys ?? RELEASE_PUBLIC_KEYS;
  // Refused before anything is fetched: without keys nothing could be trusted.
  if (keys.length === 0) verifyManifest(Buffer.alloc(0), null, keys);
  const fetcher = o.fetch ?? globalThis.fetch;
  const base = o.releasesUrl ?? RELEASES_URL;
  const bytes = await fetchLimited(fetcher, `${base}/${MANIFEST_FILE}`, MAX_MANIFEST, "the release manifest");
  if (!bytes) throw new UpdateRefused("the latest release has no machines manifest");
  const sig = await fetchLimited(fetcher, `${base}/${SIGNATURE_FILE}`, MAX_SIGNATURE, "the manifest's signature");
  return verifyManifest(bytes, sig, keys);
}

/**
 * Download `asset` into the folder of `dest` (so the rename stays on one file
 * system), checking its SHA-256 on the way. Returns the temporary file; it is
 * removed if anything is wrong.
 */
export async function downloadVerified(fetcher: typeof globalThis.fetch, asset: Asset, dest: string, what: string): Promise<string> {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(dest)}.update-${crypto.randomBytes(4).toString("hex")}`);
  const hash = crypto.createHash("sha256");
  let fd: number | null = null;
  try {
    const res = await fetcher(asset.url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`${what}: HTTP ${res.status} from ${asset.url}`);
    fd = fs.openSync(tmp, "wx", 0o700);
    let size = 0;
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += c.length;
      if (size > (asset.size ?? MAX_ASSET) || size > MAX_ASSET) throw new UpdateRefused(`${what} is larger than the manifest says; not installing it`);
      hash.update(c);
      fs.writeSync(fd, c);
    }
    fs.closeSync(fd);
    fd = null;
    const got = hash.digest("hex");
    if (got !== asset.sha256) throw new UpdateRefused(`${what} does not match the signed manifest (SHA-256 ${got}, expected ${asset.sha256}); not installing it`);
    fs.chmodSync(tmp, 0o755);
    return tmp;
  } catch (err) {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Put `tmp` where `dest` is, in one rename. Windows will not replace a running
 * executable, but lets it be renamed: the old one is moved aside first (and
 * removed on a later update, once nothing runs it).
 */
export function replaceFile(tmp: string, dest: string, platform: NodeJS.Platform = process.platform): void {
  try {
    if (platform === "win32" && fs.existsSync(dest)) {
      const old = `${dest}.old`;
      fs.rmSync(old, { force: true });
      fs.renameSync(dest, old);
    }
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function defaultCheckRuns(file: string, version: string): void {
  const out = spawnSync(file, ["--version"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  const said = (out.stdout ?? "").trim();
  if (out.status !== 0 || said !== `agentbox ${version}`) {
    throw new UpdateRefused(`the downloaded agentbox does not run here, or is not ${version} (it said ${JSON.stringify(said.slice(0, 100))}); not installing it`);
  }
}

async function updateTool(
  o: UpdateOptions,
  fetcher: typeof globalThis.fetch,
  platform: MachinePlatform,
  name: "herdr" | "Claude Code",
  installed: Installed | undefined,
  asset: VersionedAsset,
  idle: boolean,
): Promise<ComponentState> {
  if (!installed) return "none";
  if (installed.version === asset.version) return "current";
  if (!idle) return "deferred";
  if (asset.files) {
    // herdr for Windows: a zip, checked whole against the manifest, and each
    // file in it against the manifest's pin before any replaces its old self.
    const tmp = await downloadVerified(fetcher, asset, path.join(path.dirname(installed.path), "herdr.zip"), `${name} ${asset.version} for ${platform}`);
    try {
      unpackVerified(fs.readFileSync(tmp), asset.files, path.dirname(installed.path), `${name} ${asset.version} for ${platform}`, o.platform ?? process.platform);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    if (installed.versionFile) fs.writeFileSync(installed.versionFile, `${asset.version}\n`, { mode: 0o600 });
    return "updated";
  }
  const tmp = await downloadVerified(fetcher, asset, installed.path, `${name} ${asset.version} for ${platform}`);
  replaceFile(tmp, installed.path, o.platform ?? process.platform);
  if (installed.versionFile) fs.writeFileSync(installed.versionFile, `${asset.version}\n`, { mode: 0o600 });
  return "updated";
}

/**
 * One update check, as the node runs it daily and when the gate answers
 * `upgrade`. Resolves with what happened; throws UpdateRefused when a release
 * is not to be trusted (unsigned, an unknown key, older than this one, a file
 * that does not match), and other errors when a download fails.
 */
export async function checkForUpdate(o: UpdateOptions): Promise<UpdateReport> {
  if (o.policy === "off") return { state: "off" };
  const running = parseVersion(o.running);
  if (!running) throw new UpdateRefused(`this node's version (${o.running}) is not a release's, so it cannot tell what is newer; install a release build`);
  const platform = machinePlatform(o.platform ?? process.platform, o.arch ?? process.arch);
  if (!platform) throw new UpdateRefused(`no agentbox release is built for ${o.platform ?? process.platform}-${o.arch ?? process.arch}`);
  const fetcher = o.fetch ?? globalThis.fetch;

  const manifest = await fetchManifest(o);
  const order = compareVersions(parseVersion(manifest.version) as [number, number, number], running);
  if (order < 0) throw new UpdateRefused(`the latest release (${manifest.version}) is older than this node (${o.running}); not going back`);
  const assets = manifest.platforms[platform];
  if (!assets) throw new UpdateRefused(`the release ${manifest.version} has nothing for ${platform}`);

  const newer = order > 0;
  if (newer && o.policy === "notify") return { state: "available", version: manifest.version, from: o.running };

  // herdr and Claude Code: from a release no older than this node, and only
  // while no agent runs (agents live in herdr).
  const tools = async (): Promise<ToolsReport> => {
    const needed = [o.herdr && o.herdr.version !== assets.herdr.version, o.claude && o.claude.version !== assets.claude.version].some(Boolean);
    const idle = needed && o.policy === "auto" && o.idle ? await o.idle() : false;
    return {
      herdr: await updateTool(o, fetcher, platform, "herdr", o.herdr, assets.herdr, idle),
      claude: await updateTool(o, fetcher, platform, "Claude Code", o.claude, assets.claude, idle),
    };
  };

  if (!newer) return { state: "current", version: o.running, tools: o.policy === "auto" ? await tools() : { herdr: "none", claude: "none" } };
  if (o.nodePath === null) return { state: "available", version: manifest.version, from: o.running };

  // Both downloaded and checked before either is swapped in.
  const node = await downloadVerified(fetcher, assets.node, o.nodePath, `agentbox ${manifest.version} for ${platform}`);
  let gui: string | null = null;
  try {
    (o.checkRuns ?? defaultCheckRuns)(node, manifest.version);
    if (o.nodeGuiPath && assets.nodeGui) gui = await downloadVerified(fetcher, assets.nodeGui, o.nodeGuiPath, `agentbox-node.exe ${manifest.version}`);
  } catch (err) {
    fs.rmSync(node, { force: true });
    throw err;
  }
  replaceFile(node, o.nodePath, o.platform ?? process.platform);
  if (gui && o.nodeGuiPath) replaceFile(gui, o.nodeGuiPath, o.platform ?? process.platform);
  return { state: "updated", version: manifest.version, from: o.running, restart: true, tools: await tools() };
}
