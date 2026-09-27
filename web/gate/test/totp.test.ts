import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  hotp,
  matchRecoveryCode,
  otpauthUrl,
  qrSvg,
  stepAt,
  totpAt,
  verifyTotp,
} from "../src/totp.js";

// RFC 6238 appendix B, SHA-1: the ASCII secret "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP", () => {
  it("round-trips base32", () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("matches the RFC 6238 test vectors (last six digits)", () => {
    expect(totpAt(RFC_SECRET, 59_000)).toBe("287082");
    expect(totpAt(RFC_SECRET, 1111111109_000)).toBe("081804");
    expect(totpAt(RFC_SECRET, 1234567890_000)).toBe("005924");
    expect(totpAt(RFC_SECRET, 2000000000_000)).toBe("279037");
  });

  it("accepts the current step and one either side, and says which", () => {
    const now = 1_700_000_000_000;
    const s = generateSecret();
    const step = stepAt(now);
    expect(verifyTotp(s, hotp(s, step), now, 0)).toBe(step);
    expect(verifyTotp(s, hotp(s, step - 1), now, 0)).toBe(step - 1);
    expect(verifyTotp(s, hotp(s, step + 1), now, 0)).toBe(step + 1);
    expect(verifyTotp(s, hotp(s, step - 2), now, 0)).toBeNull();
    expect(verifyTotp(s, hotp(s, step + 2), now, 0)).toBeNull();
  });

  it("never accepts a code for a step at or before the last one used", () => {
    const now = 1_700_000_000_000;
    const s = generateSecret();
    const step = stepAt(now);
    expect(verifyTotp(s, hotp(s, step), now, step)).toBeNull();
    expect(verifyTotp(s, hotp(s, step - 1), now, step)).toBeNull();
    expect(verifyTotp(s, hotp(s, step + 1), now, step)).toBe(step + 1);
  });

  it("refuses anything that is not six digits", () => {
    const s = generateSecret();
    for (const c of ["", "12345", "1234567", "abcdef", " 123456"]) expect(verifyTotp(s, c, Date.now(), 0)).toBeNull();
  });

  it("describes the enrolment for an authenticator app", () => {
    const url = otpauthUrl("ABC", "owner@box.example");
    expect(url.startsWith("otpauth://totp/agentbox%3Aowner%40box.example?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("secret")).toBe("ABC");
    expect(params.get("issuer")).toBe("agentbox");
    expect(params.get("digits")).toBe("6");
    expect(params.get("period")).toBe("30");
    const svg = qrSvg(url);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('fill="#000"');
  });
});

describe("recovery codes", () => {
  it("are ten distinct 80-bit codes in four groups", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
  });

  it("match however they are typed, and only their own digest", () => {
    const codes = generateRecoveryCodes();
    const digests = codes.map(hashRecoveryCode);
    const c = codes[3] as string;
    expect(matchRecoveryCode(c, digests)).toBe(3);
    expect(matchRecoveryCode(c.toUpperCase().replace(/-/g, " "), digests)).toBe(3);
    expect(matchRecoveryCode(c.replace(/-/g, ""), digests)).toBe(3);
    expect(matchRecoveryCode("aaaa-aaaa-aaaa-aaaa", digests)).toBe(-1);
    expect(matchRecoveryCode("short", digests)).toBe(-1);
  });
});
