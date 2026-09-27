import { hash, verify } from "@node-rs/bcrypt";

/**
 * bcrypt reads at most 72 bytes of a password and silently ignores the rest,
 * so a longer password would be accepted with any tail at all. Refuse it
 * instead; Go's bcrypt (which `caddy hash-password` uses) refuses it too.
 */
export const MAX_PASSWORD_BYTES = 72;
export const MIN_PASSWORD_LENGTH = 8;

/** Why a new password is not acceptable, or `null` when it is. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return `use at most ${MAX_PASSWORD_BYTES} bytes`;
  return null;
}

export function hashPassword(password: string, cost: number): Promise<string> {
  return hash(password, cost);
}

/**
 * Compare in constant work: when there is no hash to check against, a throwaway
 * hash of the same cost is checked instead, so the response time never says
 * whether a password is set. Runs on the libuv pool, off the event loop.
 */
export class PasswordChecker {
  private dummy: Promise<string> | null = null;

  constructor(private readonly cost: number) {}

  async verify(password: string, stored: string | null): Promise<boolean> {
    const candidate = Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES ? "" : password;
    if (stored === null) {
      this.dummy ??= hash("agentbox-no-password-is-set", this.cost);
      await verify(candidate, await this.dummy).catch(() => false);
      return false;
    }
    try {
      return await verify(candidate, stored);
    } catch {
      return false;
    }
  }
}
