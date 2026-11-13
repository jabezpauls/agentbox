import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CliError } from "../errors.js";
import { writePrivate } from "./paths.js";

/**
 * Installing what the node runs into `bin/`, each verified against a pinned
 * SHA-256 before it is written. herdr's pins are those of
 * scripts/install-herdr.sh, which the sandbox image and CI use (a test keeps
 * the two the same). The signed release manifest that will carry these, and
 * Claude Code's install, come later (phases 6 and 4).
 */

export const HERDR_VERSION = "0.9.3";

export const HERDR_PINS: Record<string, { asset: string; sha256: string }> = {
  "linux-x64": { asset: "herdr-linux-x86_64", sha256: "18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7" },
  "linux-arm64": { asset: "herdr-linux-aarch64", sha256: "4de7aa3e25678812e92960de64f7c2aaa1bca1f0f80a3c5e559837e231e1f5c0" },
};

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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

/** herdr in `bin/`, pinned. Returns its path. */
export async function installHerdr(binDir: string, deps: InstallDeps): Promise<string> {
  const pin = HERDR_PINS[`${deps.platform}-${deps.arch}`];
  if (!pin) throw new CliError(`herdr ${HERDR_VERSION} has no build for ${deps.platform}/${deps.arch} that this node knows`);
  const target = path.join(binDir, "herdr");
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
