import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CliError } from "../errors.js";
import { ensurePrivateDir, writePrivate } from "./paths.js";
import { unzip } from "./unzip.js";
import { replaceFile } from "./update.js";

/**
 * Installing what the node runs into `bin/`, each verified against a pinned
 * SHA-256 before it is written. herdr's Linux pins are those of
 * scripts/install-herdr.sh, which the sandbox image and CI use; its Windows
 * pins (the zip, and each file in it) are scripts/machines-manifest.mjs's.
 * Tests keep each pair the same.
 *
 * On Windows herdr is a zip — `herdr.exe` and its ConPTY runtime — unpacked
 * into `bin\herdr\`, each file checked against its own pin.
 */

export const HERDR_VERSION = "0.9.3";

export const HERDR_PINS: Record<string, { asset: string; sha256: string }> = {
  "linux-x64": { asset: "herdr-linux-x86_64", sha256: "18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7" },
  "linux-arm64": { asset: "herdr-linux-aarch64", sha256: "4de7aa3e25678812e92960de64f7c2aaa1bca1f0f80a3c5e559837e231e1f5c0" },
};

/** herdr for Windows x64 (machines spike, question 1). */
export const HERDR_WINDOWS = {
  asset: "herdr-windows-x86_64.zip",
  sha256: "c75b1fa49f7a3ba4b8b11789912a6147e4214a3b6fd3556d0f80076c8887d795",
  size: 9846312,
  files: {
    "herdr.exe": "d12a5a55f5b3668dba8366eda8580075bf0b78201b0112df6b7234fa005a2b0d",
    "conpty/conpty.dll": "39fba2713e2495117b1591ae8c32a3b904bea7aa66069cf7815e2844c76d75d8",
    "conpty/herdr-conpty.json": "c8f499ad82c568e737d6bc7d0b583e3785d2f43af3d2c0cebb856076690533f5",
    "conpty/x64/OpenConsole.exe": "b7fd936c2668b87b9ecf7b3366dc6568afc1c6f981874cba3e955a1c35cf8160",
    "conpty/arm64/OpenConsole.exe": "ed7622fd0d3bedc9ab9f122f5e58edf0def9e7999224f52dd395ba9f54edbe09",
  } as Record<string, string>,
};

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The folder herdr is unpacked into on Windows. */
export function herdrDir(binDir: string): string {
  return path.join(binDir, "herdr");
}

/** The herdr executable the node runs: `bin/herdr`, or `bin\herdr\herdr.exe` on Windows. */
export function herdrPath(binDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? path.join(herdrDir(binDir), "herdr.exe") : path.join(binDir, "herdr");
}

export interface InstallDeps {
  platform: string;
  arch: string;
  /** Fetches a URL's bytes (follows GitHub's redirect to its object store). */
  download?: (url: string) => Promise<Uint8Array>;
  /**
   * A local copy to take instead of downloading (`AGENTBOX_NODE_HERDR_FROM`):
   * verified against the same pin, so it can only ever be the same file.
   */
  from?: string | undefined;
  log?: (line: string) => void;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (err) {
    throw new CliError(`could not download ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new CliError(`could not download ${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Every pinned file is in `dir` as pinned. */
function unpacked(dir: string, files: Record<string, string>): boolean {
  try {
    return Object.entries(files).every(([name, digest]) => sha256(fs.readFileSync(path.join(dir, ...name.split("/")))) === digest);
  } catch {
    return false;
  }
}

/**
 * The pinned files of `zip` into `dir`, each checked against its pin before
 * any is put in place, and each put in place in one rename (a running
 * `herdr.exe` is moved aside, as Windows allows). Files the pins do not name
 * are not written.
 */
export function unpackVerified(zip: Buffer, files: Record<string, string>, dir: string, what: string, platform: NodeJS.Platform = process.platform): void {
  let entries: Map<string, Buffer>;
  try {
    entries = unzip(zip);
  } catch (err) {
    throw new CliError(`${what}: ${(err as Error).message}; nothing was installed`);
  }
  const take: Array<[string, Buffer]> = [];
  for (const [name, digest] of Object.entries(files)) {
    const bytes = entries.get(name);
    if (!bytes) throw new CliError(`${what} has no ${name}; nothing was installed`);
    const got = sha256(bytes);
    if (got !== digest) throw new CliError(`${what}: ${name} failed verification (SHA-256 ${got}, expected ${digest}); nothing was installed`);
    take.push([name, bytes]);
  }
  for (const [name, bytes] of take) {
    const dest = path.join(dir, ...name.split("/"));
    ensurePrivateDir(path.dirname(dest));
    const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${randomBytes(4).toString("hex")}.tmp`);
    fs.writeFileSync(tmp, bytes, { mode: 0o700, flag: "wx" });
    replaceFile(tmp, dest, platform);
  }
}

/** herdr in `bin/`, pinned. Returns its path. */
export async function installHerdr(binDir: string, deps: InstallDeps): Promise<string> {
  if (deps.platform === "win32") return installHerdrWindows(binDir, deps);
  const pin = HERDR_PINS[`${deps.platform}-${deps.arch}`];
  if (!pin) throw new CliError(`herdr ${HERDR_VERSION} has no build for ${deps.platform}/${deps.arch} that this node knows`);
  const target = herdrPath(binDir, "linux");
  try {
    if (sha256(fs.readFileSync(target)) === pin.sha256) return target;
  } catch {
    // Not there yet.
  }
  const url = `https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/${pin.asset}`;
  deps.log?.(`Installing herdr ${HERDR_VERSION}…\n`);
  const bytes = deps.from ? new Uint8Array(fs.readFileSync(deps.from)) : await (deps.download ?? fetchBytes)(url);
  const got = sha256(bytes);
  if (got !== pin.sha256) throw new CliError(`herdr ${HERDR_VERSION} failed verification (SHA-256 ${got}, expected ${pin.sha256}); nothing was installed`);
  writePrivate(target, bytes, 0o700);
  return target;
}

async function installHerdrWindows(binDir: string, deps: InstallDeps): Promise<string> {
  // x64 only: herdr's zip has an arm64 OpenConsole, but no promise is made for Windows on Arm.
  if (deps.arch !== "x64") throw new CliError(`herdr ${HERDR_VERSION} has no build for win32/${deps.arch} that this node knows`);
  const dir = herdrDir(binDir);
  const exe = herdrPath(binDir, "win32");
  if (unpacked(dir, HERDR_WINDOWS.files)) return exe;
  const url = `https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/${HERDR_WINDOWS.asset}`;
  deps.log?.(`Installing herdr ${HERDR_VERSION}…\n`);
  const bytes = deps.from ? new Uint8Array(fs.readFileSync(deps.from)) : await (deps.download ?? fetchBytes)(url);
  const got = sha256(bytes);
  if (got !== HERDR_WINDOWS.sha256) throw new CliError(`herdr ${HERDR_VERSION} failed verification (SHA-256 ${got}, expected ${HERDR_WINDOWS.sha256}); nothing was installed`);
  unpackVerified(Buffer.from(bytes), HERDR_WINDOWS.files, dir, `herdr ${HERDR_VERSION}`, "win32");
  return exe;
}
