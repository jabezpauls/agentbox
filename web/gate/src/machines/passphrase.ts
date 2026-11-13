import { MAX_PASSWORD_BYTES, PasswordChecker, hashPassword } from "../password.js";
import type { Store } from "../store.js";

/**
 * The machines passphrase: the second thing, beside a main session, that the
 * machines origin's sign-in needs. The sandbox can read what is typed on the
 * box's origin — the password and two-factor codes included — so this is set
 * on the host only (`agentbox machines enable`, which pipes it to the gate's
 * CLI on stdin) and only ever typed on the machines origin. Stored as bcrypt,
 * at the gate's cost (14).
 */

export const MIN_PASSPHRASE_LENGTH = 12;

export class PassphraseError extends Error {}

export function passphraseProblem(passphrase: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) return `use at least ${MIN_PASSPHRASE_LENGTH} characters`;
  if (Buffer.byteLength(passphrase, "utf8") > MAX_PASSWORD_BYTES) return `use at most ${MAX_PASSWORD_BYTES} bytes`;
  return null;
}

/**
 * Set (or change) the passphrase. Refuses the sign-in password: that one is
 * typed on the box's origin, where the sandbox may have read it. Every
 * machines session ends.
 */
export async function setPassphrase(
  deps: { store: Store; cost: number; now?: () => number },
  passphrase: string,
): Promise<{ endedSessions: number }> {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new PassphraseError(`passphrase not accepted: ${problem}`);
  const { store } = deps;
  const main = store.data.password?.hash ?? null;
  if (main !== null && (await new PasswordChecker(deps.cost).verify(passphrase, main))) {
    throw new PassphraseError("passphrase not accepted: it is the sign-in password; choose one you never type on the box");
  }
  const hash = await hashPassword(passphrase, deps.cost);
  const m = store.data.machines;
  const endedSessions = m.sessions.length;
  m.passphrase = { hash, updatedAt: (deps.now ?? Date.now)() };
  m.generation += 1;
  m.sessions = [];
  await store.save();
  return { endedSessions };
}

/** Machines turned off: the passphrase is forgotten and every machines session ends. */
export async function clearMachines(store: Store): Promise<{ endedSessions: number }> {
  const m = store.data.machines;
  const endedSessions = m.sessions.length;
  m.passphrase = null;
  m.generation += 1;
  m.sessions = [];
  await store.save();
  return { endedSessions };
}
