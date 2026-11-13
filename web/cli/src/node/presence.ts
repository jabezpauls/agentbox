import { pbkdf2, randomBytes } from "node:crypto";
import { CliError } from "../errors.js";
import type { Presence } from "./credentials.js";
import type { Prompter } from "./prompt.js";

/**
 * Presence, enrolment only (the challenge and grant come in phase 4).
 *
 * The machines passphrase is typed on this machine's own terminal, never sent
 * anywhere: the node keeps `K = PBKDF2-SHA256(passphrase, salt, 600 000)` and
 * the fresh random salt, which the browser later proves knowledge of with an
 * HMAC under the same `K`. The box never holds either in a form it could
 * replace.
 */

export const PRESENCE_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 12;

export function derive(passphrase: string, salt: Buffer, iterations = PRESENCE_ITERATIONS): Promise<Buffer> {
  return new Promise((resolve, reject) => pbkdf2(passphrase, salt, iterations, 32, "sha256", (err, key) => (err ? reject(err) : resolve(key))));
}

export async function enrol(passphrase: string, now: number, iterations = PRESENCE_ITERATIONS): Promise<Presence> {
  const salt = randomBytes(16);
  const key = await derive(passphrase, salt, iterations);
  return { algorithm: "PBKDF2-SHA256", iterations, salt: salt.toString("base64url"), key: key.toString("base64url"), createdAt: now };
}

/** Ask for the machines passphrase twice, with no echo. */
export async function askPassphrase(prompt: Prompter, err: (s: string) => void): Promise<string> {
  err("The machines passphrase (the one set on the box's host with `agentbox machines enable`).\n");
  err("This machine keeps only a key derived from it; the box never sees it from here.\n");
  const pass = await prompt.secret("Machines passphrase: ");
  if (pass.length < MIN_PASSPHRASE_LENGTH) throw new CliError(`the machines passphrase has at least ${MIN_PASSPHRASE_LENGTH} characters`);
  const again = await prompt.secret("Again: ");
  if (again !== pass) throw new CliError("the passphrases did not match");
  return pass;
}
