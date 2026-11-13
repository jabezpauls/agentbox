import crypto from "node:crypto";

/**
 * The signed machines manifest: what each release says a machine's node,
 * herdr and Claude Code should be, per platform, with the SHA-256 of each.
 * Written and signed in CI by scripts/machines-manifest.mjs; read here only
 * after its signature checks out against a key the node was built with.
 */

export type MachinePlatform = "linux-x64" | "linux-arm64" | "win-x64";
export const MACHINE_PLATFORMS: readonly MachinePlatform[] = ["linux-x64", "linux-arm64", "win-x64"];

export interface Asset {
  url: string;
  sha256: string;
  size?: number;
}

export interface VersionedAsset extends Asset {
  version: string;
  /** For an archive (herdr on Windows): the SHA-256 of each file inside it. */
  files?: Record<string, string>;
}

export interface PlatformAssets {
  /** The node: the standalone executable. */
  node: Asset;
  /** Windows: the same executable with no console (`agentbox-node.exe`). */
  nodeGui?: Asset;
  herdr: VersionedAsset;
  claude: VersionedAsset;
}

export interface Manifest {
  schema: 1;
  version: string;
  platforms: Partial<Record<MachinePlatform, PlatformAssets>>;
}

/** An update that is not taken, and why, in words for the owner. */
export class UpdateRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateRefused";
  }
}

/** The platform names the manifest uses, for this OS and CPU; `null` where no node is built. */
export function machinePlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): MachinePlatform | null {
  const k = `${platform === "win32" ? "win" : platform}-${arch}`;
  return (MACHINE_PLATFORMS as readonly string[]).includes(k) ? (k as MachinePlatform) : null;
}

/** A release version, `vX.Y.Z`, as numbers; `null` for anything else. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative, zero or positive as `a` is older than, the same as, or newer than `b`. */
export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The manifest, if `signature` (base64, as the release's .sig holds it) is an
 * ed25519 signature of exactly these bytes by one of `keys`. Throws
 * UpdateRefused otherwise; nothing in an unverified manifest is looked at.
 */
export function verifyManifest(bytes: Buffer, signature: string | Buffer | null, keys: readonly string[]): Manifest {
  if (keys.length === 0) {
    throw new UpdateRefused(
      "this build of agentbox has no release keys built in, so it cannot check that an update is genuine; it does not update itself (install a release build from https://github.com/jabezpauls/agentbox/releases)",
    );
  }
  const text = (Buffer.isBuffer(signature) ? signature.toString("utf8") : (signature ?? "")).trim();
  const sig = /^[A-Za-z0-9+/]{86}==$/.test(text) ? Buffer.from(text, "base64") : null;
  if (!sig || sig.length !== 64) throw new UpdateRefused("the release manifest is not signed (no valid signature beside it); not updating");
  const trusted = keys.some((pem) => {
    try {
      const key = crypto.createPublicKey(pem);
      return key.asymmetricKeyType === "ed25519" && crypto.verify(null, bytes, key, sig);
    } catch {
      return false;
    }
  });
  if (!trusted) throw new UpdateRefused("the release manifest is not signed by a release key this node trusts; not updating");
  return parseManifest(bytes);
}

const HEX64 = /^[0-9a-f]{64}$/;

function asset(v: unknown, where: string, versioned: boolean): Asset | VersionedAsset {
  const a = v as Record<string, unknown> | null;
  if (!a || typeof a !== "object") throw new UpdateRefused(`the release manifest has no ${where}`);
  if (typeof a.url !== "string" || !/^https:\/\//.test(a.url)) throw new UpdateRefused(`the release manifest's ${where} has no https URL`);
  if (typeof a.sha256 !== "string" || !HEX64.test(a.sha256)) throw new UpdateRefused(`the release manifest's ${where} has no SHA-256`);
  const out: Asset = { url: a.url, sha256: a.sha256 };
  if (typeof a.size === "number" && Number.isSafeInteger(a.size) && a.size > 0) out.size = a.size;
  if (!versioned) return out;
  if (typeof a.version !== "string" || !/^[0-9A-Za-z.+-]{1,64}$/.test(a.version)) throw new UpdateRefused(`the release manifest's ${where} has no version`);
  const entry: VersionedAsset = { ...out, version: a.version };
  if (a.files !== undefined) {
    const f = a.files as Record<string, unknown>;
    if (!f || typeof f !== "object" || !Object.values(f).every((d) => typeof d === "string" && HEX64.test(d))) {
      throw new UpdateRefused(`the release manifest's ${where} lists files without a SHA-256 each`);
    }
    entry.files = f as Record<string, string>;
  }
  return entry;
}

/** The manifest's shape, checked; only called on bytes whose signature verified. */
export function parseManifest(bytes: Buffer): Manifest {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new UpdateRefused("the release manifest is not JSON");
  }
  if (!raw || typeof raw !== "object" || raw.schema !== 1) throw new UpdateRefused("the release manifest is of a kind this node does not know; update it by hand");
  if (typeof raw.version !== "string" || !parseVersion(raw.version)) throw new UpdateRefused("the release manifest has no version");
  const platforms: Manifest["platforms"] = {};
  const given = (raw.platforms ?? {}) as Record<string, unknown>;
  for (const p of MACHINE_PLATFORMS) {
    const e = given[p] as Record<string, unknown> | undefined;
    if (!e) continue;
    const entry: PlatformAssets = {
      node: asset(e.node, `${p} node`, false),
      herdr: asset(e.herdr, `${p} herdr`, true) as VersionedAsset,
      claude: asset(e.claude, `${p} Claude Code`, true) as VersionedAsset,
    };
    if (e.nodeGui !== undefined) entry.nodeGui = asset(e.nodeGui, `${p} windowless node`, false);
    platforms[p] = entry;
  }
  return { schema: 1, version: raw.version, platforms };
}
