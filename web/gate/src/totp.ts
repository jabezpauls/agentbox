import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import qrcode from "qrcode-generator";

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226): HMAC-SHA1, 30-second
 * steps, six digits — what every authenticator app speaks by default.
 */

export const STEP_SECONDS = 30;
const DIGITS = 6;
/** Steps either side of now that still count, for a phone clock a little off. */
const DRIFT_STEPS = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, base32, the size RFC 4226 recommends for SHA-1. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

export function totpAt(secret: string, nowMs: number): string {
  return hotp(secret, stepAt(nowMs));
}

/**
 * The step a code is valid for, or `null`. Only steps after `lastStep` are
 * considered, so a code — or any earlier one — cannot be replayed once used.
 */
export function verifyTotp(secret: string, code: string, nowMs: number, lastStep: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepAt(nowMs);
  const given = Buffer.from(code);
  let match: number | null = null;
  // Every candidate is compared, so the time taken does not say which matched.
  for (let step = now - DRIFT_STEPS; step <= now + DRIFT_STEPS; step++) {
    if (step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), given) && match === null) match = step;
  }
  return match;
}

export function otpauthUrl(secret: string, account: string, issuer = "agentbox"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * A QR code as a self-contained SVG: dark modules on white regardless of the
 * page's theme, because that is what phone cameras read reliably.
 */
export function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 4;
  const size = n + margin * 2;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
  );
}

// Recovery codes: 16 base32 characters (80 bits) in four groups. That much
// entropy is what lets them be stored as a plain SHA-256 digest — a leaked store
// cannot be brute-forced back to a usable code.
const RECOVERY_COUNT = 10;
const RECOVERY_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z2-7]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_COUNT; i++) {
    const bytes = randomBytes(16);
    let raw = "";
    for (const b of bytes) raw += RECOVERY_ALPHABET[b & 31];
    codes.push(raw.match(/.{4}/g)!.join("-"));
  }
  return codes;
}

/** Index of the stored digest a recovery code matches, or -1. */
export function matchRecoveryCode(code: string, digests: string[]): number {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length !== 16) return -1;
  const given = Buffer.from(hashRecoveryCode(normalized), "hex");
  let found = -1;
  digests.forEach((d, i) => {
    const stored = Buffer.from(d, "hex");
    if (stored.length === given.length && timingSafeEqual(stored, given) && found === -1) found = i;
  });
  return found;
}
