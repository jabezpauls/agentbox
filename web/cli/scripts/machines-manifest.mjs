#!/usr/bin/env node
// Write, and sign, the machines manifest a release carries: for each platform
// the node's executable, herdr and Claude Code, each with a URL and SHA-256.
// A machine's node takes an update only from a manifest signed by a key it
// was built with (src/node/release-keys.ts; RELEASING.md for the keys).
//
//   MACHINES_SIGNING_KEY="$(cat key.pem)" \
//   node scripts/machines-manifest.mjs --tag vX.Y.Z --assets dist/sea/assets.json --out dist/machines [--require-signature]
//
// The key is an ed25519 private key, PEM (PKCS#8), from the environment only.
// Without it the manifest is written unsigned, and --require-signature (as
// the release runs it) fails instead.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

// Claude Code, pinned (docs/design/2026-11-13-machines-design.md, "Claude Code
// on a machine"): the digests are the `checksum`s of Anthropic's manifest,
// https://downloads.claude.ai/claude-code-releases/2.1.311/manifest.json,
// and the files hash to them.
const CLAUDE_VERSION = "2.1.311";
const CLAUDE = {
  "linux-x64": { path: "linux-x64/claude", sha256: "86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada", size: 293776752 },
  "linux-arm64": { path: "linux-arm64/claude", sha256: "2e2496c9a8065df93acb0fca2d341f59a6b8777649b2e025ab8c9bcd5eef61f3", size: 293658808 },
  "win-x64": { path: "win32-x64/claude.exe", sha256: "966f4b2ce962298f5dee6a942e8c47c8f97392e69e728e622319a98b259c0680", size: 298870432 },
};

// herdr: Linux's version and digests are scripts/install-herdr.sh's (the one
// place they live, read below). Windows ships a zip; the node unpacks it and
// checks each file inside (machines spike, question 1).
const HERDR_WINDOWS = {
  asset: "herdr-windows-x86_64.zip",
  sha256: "c75b1fa49f7a3ba4b8b11789912a6147e4214a3b6fd3556d0f80076c8887d795",
  size: 9846312,
  files: {
    "herdr.exe": "d12a5a55f5b3668dba8366eda8580075bf0b78201b0112df6b7234fa005a2b0d",
    "conpty/conpty.dll": "39fba2713e2495117b1591ae8c32a3b904bea7aa66069cf7815e2844c76d75d8",
    "conpty/herdr-conpty.json": "c8f499ad82c568e737d6bc7d0b583e3785d2f43af3d2c0cebb856076690533f5",
    "conpty/x64/OpenConsole.exe": "b7fd936c2668b87b9ecf7b3366dc6568afc1c6f981874cba3e955a1c35cf8160",
    "conpty/arm64/OpenConsole.exe": "ed7622fd0d3bedc9ab9f122f5e58edf0def9e7999224f52dd395ba9f54edbe09",
  },
};
const HERDR_WINDOWS_VERSION = "0.9.3";

function herdrLinux() {
  const sh = fs.readFileSync(path.join(repoRoot, "scripts", "install-herdr.sh"), "utf8");
  const version = /HERDR_VERSION="\$\{HERDR_VERSION:-([0-9.]+)\}"/.exec(sh)?.[1];
  const pin = (asset) => new RegExp(`asset="${asset}"\\s+sha="([0-9a-f]{64})"`).exec(sh)?.[1];
  const x64 = pin("herdr-linux-x86_64");
  const arm64 = pin("herdr-linux-aarch64");
  if (!version || !x64 || !arm64) throw new Error("cannot read herdr's version and digests from scripts/install-herdr.sh");
  return { version, "linux-x64": { asset: "herdr-linux-x86_64", sha256: x64 }, "linux-arm64": { asset: "herdr-linux-aarch64", sha256: arm64 } };
}

function args(argv) {
  const o = { requireSignature: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tag") o.tag = argv[++i];
    else if (a === "--assets") o.assets = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--require-signature") o.requireSignature = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!/^v\d+\.\d+\.\d+$/.test(o.tag ?? "")) throw new Error("--tag vX.Y.Z is required");
  if (!o.assets || !o.out) throw new Error("--assets and --out are required");
  return o;
}

/**
 * The public keys built into the node, as PEM, read from its source. Tests
 * stand in keys of their own with MACHINES_TRUSTED_KEYS (PEM blocks); a
 * release never sets it.
 */
function builtInKeys() {
  const src = process.env.MACHINES_TRUSTED_KEYS ?? fs.readFileSync(path.join(here, "..", "src", "node", "release-keys.ts"), "utf8");
  return [...src.matchAll(/-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s\\n]+?-----END PUBLIC KEY-----/g)].map((m) => m[0].replace(/\\n/g, "\n"));
}

const o = args(process.argv.slice(2));
const built = JSON.parse(fs.readFileSync(o.assets, "utf8"));
const repo = process.env.GITHUB_REPOSITORY || "jabezpauls/agentbox";
const download = (file) => `https://github.com/${repo}/releases/download/${o.tag}/${file}`;
const herdr = herdrLinux();

const platforms = {};
for (const platform of ["linux-x64", "linux-arm64", "win-x64"]) {
  const b = built.platforms?.[platform];
  if (!b?.node) throw new Error(`${o.assets} has no ${platform} executable; build all three (scripts/build-sea.mjs)`);
  const asset = (a) => ({ url: download(a.file), sha256: a.sha256, size: a.size });
  const entry = { node: asset(b.node) };
  if (platform === "win-x64") {
    if (!b.nodeGui) throw new Error(`${o.assets} has no agentbox-node.exe`);
    entry.nodeGui = asset(b.nodeGui);
    entry.herdr = {
      version: HERDR_WINDOWS_VERSION,
      url: `https://github.com/herdrdev/herdr/releases/download/v${HERDR_WINDOWS_VERSION}/${HERDR_WINDOWS.asset}`,
      sha256: HERDR_WINDOWS.sha256,
      size: HERDR_WINDOWS.size,
      files: HERDR_WINDOWS.files,
    };
  } else {
    entry.herdr = {
      version: herdr.version,
      url: `https://github.com/herdrdev/herdr/releases/download/v${herdr.version}/${herdr[platform].asset}`,
      sha256: herdr[platform].sha256,
    };
  }
  const c = CLAUDE[platform];
  entry.claude = { version: CLAUDE_VERSION, url: `https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/${c.path}`, sha256: c.sha256, size: c.size };
  platforms[platform] = entry;
}
if (herdr.version !== HERDR_WINDOWS_VERSION) {
  throw new Error(`install-herdr.sh pins herdr ${herdr.version}, this script ${HERDR_WINDOWS_VERSION} for Windows: pin the same release for both`);
}

const manifest = Buffer.from(`${JSON.stringify({ schema: 1, version: o.tag, platforms }, null, 2)}\n`);
fs.mkdirSync(o.out, { recursive: true });
const file = path.join(o.out, "machines-manifest.json");
fs.writeFileSync(file, manifest);
console.log(`wrote ${file} (${o.tag})`);

const pem = process.env.MACHINES_SIGNING_KEY ?? "";
if (!pem.trim()) {
  if (o.requireSignature) {
    console.error("MACHINES_SIGNING_KEY is not set: a release's machines manifest must be signed, and machines would refuse it unsigned. Set the repository secret (RELEASING.md, \"Signing machines releases\").");
    process.exit(1);
  }
  console.log("MACHINES_SIGNING_KEY is not set: the manifest is unsigned");
  process.exit(0);
}
let key;
try {
  key = crypto.createPrivateKey(pem);
} catch {
  console.error("MACHINES_SIGNING_KEY is not a PEM private key");
  process.exit(1);
}
if (key.asymmetricKeyType !== "ed25519") {
  console.error(`MACHINES_SIGNING_KEY is an ${key.asymmetricKeyType} key; it must be ed25519`);
  process.exit(1);
}
const sig = crypto.sign(null, manifest, key);
const pub = crypto.createPublicKey(key);
if (!crypto.verify(null, manifest, pub, sig)) throw new Error("the signature does not verify");
fs.writeFileSync(`${file}.sig`, `${sig.toString("base64")}\n`);
const spki = pub.export({ type: "spki", format: "der" });
console.log(`signed with the key whose public half's SHA-256 is ${crypto.createHash("sha256").update(spki).digest("hex")}`);

// A release signed with a key the node does not carry would be refused by
// every machine: say so here, not on the machines.
const keys = builtInKeys().map((k) => crypto.createPublicKey(k).export({ type: "spki", format: "der" }));
if (keys.length === 0) {
  console.log("::warning::src/node/release-keys.ts has no public keys yet: machines cannot verify this release (RELEASING.md)");
} else if (!keys.some((k) => k.equals(spki))) {
  console.error("MACHINES_SIGNING_KEY's public key is not among those in src/node/release-keys.ts: every machine would refuse this release");
  process.exit(1);
}
