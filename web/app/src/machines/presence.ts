// Presence, the browser's half: prove to a machine that the owner is here,
// with the machines passphrase, without the passphrase or the key derived
// from it ever leaving this tab.
//
// The machine sends a fresh challenge and its salt (through the gate). The
// tab derives K = PBKDF2-SHA256(passphrase, salt, iterations) — what the
// machine kept when it joined — and answers HMAC-SHA256(K, challenge ‖
// machines session id ‖ machine id), base64url. The node computes the same
// (web/cli/src/node/presence.ts) and, when it matches, issues a grant the
// gate holds for this session.
//
// The passphrase is held in this tab's memory and its sessionStorage (so a
// reload does not ask again), never in localStorage, never sent anywhere.

const STORE_KEY = "agentbox.machines.passphrase";

let held: string | null = null;

export function heldPassphrase(): string | null {
  if (held !== null) return held;
  try {
    held = sessionStorage.getItem(STORE_KEY);
  } catch {
    held = null;
  }
  return held;
}

export function holdPassphrase(p: string): void {
  held = p;
  try {
    sessionStorage.setItem(STORE_KEY, p);
  } catch {
    // Storage blocked: memory alone, asked again after a reload.
  }
}

export function forgetPassphrase(): void {
  held = null;
  try {
    sessionStorage.removeItem(STORE_KEY);
  } catch {
    // Nothing stored.
  }
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes signed: the challenge, then the session id and the machine id as UTF-8. */
export function presenceMessage(challenge: string, sessionId: string, machineId: string): Uint8Array<ArrayBuffer> {
  const c = fromB64url(challenge);
  const rest = new TextEncoder().encode(`${sessionId}${machineId}`);
  const out = new Uint8Array(c.length + rest.length);
  out.set(c, 0);
  out.set(rest, c.length);
  return out;
}

/** K, as the machine derived it when it joined. */
export async function deriveKey(passphrase: string, salt: string, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromB64url(salt), iterations }, base, 256);
  return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function presenceAnswer(passphrase: string, c: { challenge: string; salt: string; iterations: number; session: string; machine: string }): Promise<string> {
  const key = await deriveKey(passphrase, c.salt, c.iterations);
  const mac = await crypto.subtle.sign("HMAC", key, presenceMessage(c.challenge, c.session, c.machine));
  return toB64url(new Uint8Array(mac));
}
