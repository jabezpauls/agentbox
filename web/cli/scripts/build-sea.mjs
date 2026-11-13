#!/usr/bin/env node
// Build the standalone executables: the CLI with Node built in, for machines
// that have no Node (Node's single-executable applications).
//
//   node scripts/build-sea.mjs [--targets linux-x64,linux-arm64,win-x64] [--out dist/sea]
//
// 1. esbuild bundles src/sea.ts as one CommonJS file (a SEA runs CommonJS,
//    and cli.ts's top-level `await` is not allowed there);
// 2. Node writes it into a SEA blob (no code cache or snapshot, so one blob
//    serves every platform);
// 3. for each platform, the official Node binary, checked against the digest
//    pinned below and against nodejs.org's SHASUMS256.txt, gets the blob
//    injected with postject;
// 4. on Windows, agentbox-node.exe is that same executable with its PE
//    subsystem set to GUI, so it starts with no console window.
//
// Cross-builds from Linux. Writes, beside the executables, SHA256SUMS and
// assets.json (what scripts/machines-manifest.mjs lists in the signed manifest).
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { SUBSYSTEM, setSubsystem } from "./pe-subsystem.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));

// The Node every executable carries: 24 (LTS to April 2028). Bumping it means
// new digests, from https://nodejs.org/dist/<version>/SHASUMS256.txt.
const NODE_VERSION = "v24.22.3";
const NODE = {
  "linux-x64": {
    file: `node-${NODE_VERSION}-linux-x64.tar.xz`,
    sha256: "4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb",
    member: `node-${NODE_VERSION}-linux-x64/bin/node`,
    out: "agentbox-linux-x64",
  },
  "linux-arm64": {
    file: `node-${NODE_VERSION}-linux-arm64.tar.xz`,
    sha256: "6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c",
    member: `node-${NODE_VERSION}-linux-arm64/bin/node`,
    out: "agentbox-linux-arm64",
  },
  "win-x64": {
    file: "win-x64/node.exe",
    sha256: "86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6",
    out: "agentbox.exe",
    gui: "agentbox-node.exe",
  },
};
// Node's marker for "a blob has been injected" (postject flips its last byte).
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function args(argv) {
  const o = { targets: Object.keys(NODE), out: path.join(pkgDir, "dist", "sea") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--targets") o.targets = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (argv[i] === "--out") o.out = path.resolve(argv[++i] ?? "");
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  for (const t of o.targets) if (!(t in NODE)) throw new Error(`unknown target ${t}; one of ${Object.keys(NODE).join(", ")}`);
  if (o.targets.length === 0) throw new Error("no targets");
  return o;
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

let shasums;
/** The digest nodejs.org lists for a file of this release; must agree with the one pinned here. */
async function officialDigest(file) {
  shasums ??= (await download(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`)).toString("utf8");
  const line = shasums.split("\n").find((l) => l.trim().split(/\s+/)[1] === file);
  if (!line) throw new Error(`SHASUMS256.txt for ${NODE_VERSION} does not list ${file}`);
  return line.trim().split(/\s+/)[0];
}

/** The official `node` (or node.exe) for a target, verified, cached under the cache folder. */
async function nodeBinary(target, cache) {
  const t = NODE[target];
  const bin = path.join(cache, `${target}-node${target.startsWith("win") ? ".exe" : ""}`);
  if (fs.existsSync(bin) && fs.existsSync(`${bin}.verified`)) return bin;
  const official = await officialDigest(t.file);
  if (official !== t.sha256) throw new Error(`${t.file}: nodejs.org lists ${official}, this script pins ${t.sha256}`);
  const data = await download(`https://nodejs.org/dist/${NODE_VERSION}/${t.file}`);
  const got = sha256(data);
  if (got !== t.sha256) throw new Error(`${t.file}: SHA-256 ${got}, expected ${t.sha256}`);
  fs.mkdirSync(cache, { recursive: true });
  if (t.member) {
    const archive = path.join(cache, path.basename(t.file));
    fs.writeFileSync(archive, data);
    const dir = path.join(cache, `${target}-x`);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("tar", ["-xJf", archive, "-C", dir, t.member]);
    fs.copyFileSync(path.join(dir, t.member), bin);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
  } else {
    fs.writeFileSync(bin, data);
  }
  fs.chmodSync(bin, 0o755);
  fs.writeFileSync(`${bin}.verified`, `${t.sha256}\n`);
  return bin;
}

/** The platform this build runs on, in the targets' names, if it is one. */
function hostTarget() {
  const k = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
  return k in NODE ? k : null;
}

const o = args(process.argv.slice(2));
const stamped = process.env.AGENTBOX_VERSION ?? "";
const version = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(stamped) ? stamped : pkg.version;
const cache = path.join(pkgDir, "dist", "sea-cache", NODE_VERSION);
fs.mkdirSync(o.out, { recursive: true });

// 1. The bundle.
const bundle = path.join(o.out, "agentbox.cjs");
await build({
  entryPoints: [path.join(pkgDir, "src", "sea.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  // ws's optional native speed-ups: absent, it falls back to JavaScript. No
  // native add-on is ever loaded.
  external: ["bufferutil", "utf-8-validate"],
  define: { __AGENTBOX_CLI_VERSION__: JSON.stringify(version), __AGENTBOX_STANDALONE__: "true" },
  legalComments: "none",
  logLevel: "warning",
});

// 2. The blob, made by the same Node release the executables carry: this
// process if it is that release, else the host's downloaded copy.
const host = hostTarget();
let blobNode;
if (process.version === NODE_VERSION) blobNode = process.execPath;
else if (host && !host.startsWith("win")) blobNode = await nodeBinary(host, cache);
else throw new Error(`run this with Node ${NODE_VERSION}, or on Linux x64/arm64, to make the SEA blob`);
const blob = path.join(o.out, "agentbox.blob");
const seaConfig = path.join(o.out, "sea-config.json");
fs.writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2),
);
execFileSync(blobNode, ["--experimental-sea-config", seaConfig], { stdio: ["ignore", "ignore", "inherit"] });
const blobData = fs.readFileSync(blob);

// 3–4. One executable per target.
const { inject } = require("postject");
const assets = { version, node: NODE_VERSION, platforms: {} };
const sums = [];
const record = (target, key, file) => {
  const data = fs.readFileSync(file);
  const entry = { file: path.basename(file), sha256: sha256(data), size: data.length };
  (assets.platforms[target] ??= {})[key] = entry;
  sums.push(`${entry.sha256}  ${entry.file}`);
  console.log(`built ${path.relative(process.cwd(), file)} (${target}, ${(data.length / 1024 / 1024).toFixed(1)} MiB, sha256 ${entry.sha256})`);
};
for (const target of o.targets) {
  const t = NODE[target];
  const src = await nodeBinary(target, cache);
  const out = path.join(o.out, t.out);
  fs.rmSync(out, { force: true });
  fs.copyFileSync(src, out);
  fs.chmodSync(out, 0o755);
  // On Windows postject warns that node.exe's signature is now broken: it is
  // (the OpenJS Foundation signed the file it was), so the result is unsigned.
  await inject(out, "NODE_SEA_BLOB", blobData, { sentinelFuse: SENTINEL });
  if (target === host) {
    const said = execFileSync(out, ["--version"], { encoding: "utf8" }).trim();
    if (said !== `agentbox ${version}`) throw new Error(`${out} --version said ${JSON.stringify(said)}`);
  }
  record(target, "node", out);
  if (t.gui) {
    const gui = path.join(o.out, t.gui);
    const { out: patched, offset } = setSubsystem(fs.readFileSync(out), SUBSYSTEM.gui);
    fs.writeFileSync(gui, patched, { mode: 0o755 });
    console.log(`  ${t.gui}: the same, subsystem set to GUI at 0x${offset.toString(16)}`);
    record(target, "nodeGui", gui);
  }
}
fs.writeFileSync(path.join(o.out, "SHA256SUMS"), `${sums.join("\n")}\n`);
fs.writeFileSync(path.join(o.out, "assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
fs.rmSync(blob, { force: true });
fs.rmSync(seaConfig, { force: true });
