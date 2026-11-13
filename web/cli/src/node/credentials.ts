import fs from "node:fs";
import { NODE_TOKEN_SHAPE } from "@workbench/hostcore/link";
import { CliError } from "../errors.js";
import { writePrivate } from "./paths.js";

/**
 * `credentials.json`: what joining left behind. The node token (the link's
 * only credential, never printed), which machine this is at which box, and
 * the presence verifier — `K = PBKDF2-SHA256(passphrase, salt, 600 000)` and
 * its salt — which the box never sees in a form it could replace.
 */

export interface Presence {
  algorithm: "PBKDF2-SHA256";
  iterations: number;
  /** base64url. */
  salt: string;
  /** The derived key, base64url. */
  key: string;
  createdAt: number;
}

export interface Credentials {
  version: 1;
  /** The box's origin. */
  box: string;
  machineId: string;
  name: string;
  token: string;
  presence: Presence;
  joinedAt: number;
  /** Set when the box revoked this machine (its signed `revoked`). */
  revokedAt?: number;
}

export function readCredentials(file: string): Credentials | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let c: Partial<Credentials>;
  try {
    c = JSON.parse(raw) as Partial<Credentials>;
  } catch {
    throw new CliError(`${file} is not valid JSON; this machine cannot link until it is fixed or re-joined`);
  }
  const p = c.presence;
  if (
    c.version !== 1 ||
    typeof c.box !== "string" ||
    typeof c.machineId !== "string" ||
    typeof c.name !== "string" ||
    typeof c.token !== "string" ||
    !NODE_TOKEN_SHAPE.test(c.token) ||
    !p ||
    typeof p.salt !== "string" ||
    typeof p.key !== "string" ||
    typeof p.iterations !== "number"
  ) {
    throw new CliError(`${file} is not a node's credentials; re-join this machine`);
  }
  return c as Credentials;
}

export function writeCredentials(file: string, c: Credentials): void {
  writePrivate(file, `${JSON.stringify(c, null, 2)}\n`);
}
