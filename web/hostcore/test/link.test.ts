import { describe, expect, it } from "vitest";
import {
  CONTROL_MAX_BYTES,
  decodeControl,
  decodeFrame,
  encodeControl,
  encodeFrame,
  FrameError,
  FrameType,
  parseHello,
  revokeMac,
  tokenDigest,
  verifyRevoke,
} from "../src/link/index.js";

const policy = { terminals: false, files: [], ports: false, share: false, updates: "auto", presenceHours: 12, paused: false, problem: null };
const hello = {
  type: "hello",
  protocol: 1,
  version: "1.2.3",
  nonce: "a".repeat(43),
  platform: "linux",
  arch: "x64",
  hostname: "laptop",
  cpu: { model: "cpu", cores: 8 },
  ramBytes: 16e9,
  disks: [{ path: "/home/x/code", freeBytes: 1e9 }],
  gpus: [],
  docker: true,
  claude: null,
  policy,
};

describe("link frames", () => {
  it("round-trip every type", () => {
    for (const type of [FrameType.open, FrameType.data, FrameType.close, FrameType.window]) {
      const f = decodeFrame(encodeFrame(type, 0xfffffffe, Buffer.from("hi")));
      expect(f).toEqual({ type, stream: 0xfffffffe, payload: Buffer.from("hi") });
    }
    const c = decodeFrame(encodeControl({ type: "ok", machineId: "m" }));
    expect(c.type).toBe(FrameType.control);
    expect(decodeControl(c.payload)).toEqual({ type: "ok", machineId: "m" });
  });

  it("refuse what is malformed", () => {
    expect(() => decodeFrame(Buffer.from([1, 0, 0]))).toThrow(FrameError);
    expect(() => decodeFrame(Buffer.from([9, 0, 0, 0, 1]))).toThrow(/unknown frame type/);
    // Control is on stream 0 only, and streams never are.
    expect(() => decodeFrame(Buffer.from([FrameType.control, 0, 0, 0, 1]))).toThrow(/stream 0/);
    expect(() => decodeFrame(Buffer.from([FrameType.data, 0, 0, 0, 0]))).toThrow(/stream 0/);
    expect(() => encodeFrame(FrameType.data, 0)).toThrow(FrameError);
    expect(() => encodeFrame(FrameType.data, -1)).toThrow(FrameError);
  });

  it("bound control messages at 64 KiB", () => {
    const big = Buffer.concat([Buffer.from([FrameType.control, 0, 0, 0, 0]), Buffer.alloc(CONTROL_MAX_BYTES + 1, 0x20)]);
    expect(() => decodeFrame(big)).toThrow(/too large/);
    expect(() => encodeControl({ type: "x", pad: "y".repeat(CONTROL_MAX_BYTES) })).toThrow(/too large/);
  });

  it("want a JSON object with a type in control", () => {
    for (const bad of ["nope", "[]", "null", '{"a":1}', '{"type":""}']) {
      expect(() => decodeControl(Buffer.from(bad))).toThrow(FrameError);
    }
  });
});

describe("the hello", () => {
  it("is cleaned and bounded", () => {
    const h = parseHello({ ...hello, hostname: "lap\u001btop", extra: "dropped", gpus: Array(100).fill({ name: "g", memoryMiB: 1 }) });
    expect(typeof h).toBe("object");
    if (typeof h === "string") return;
    expect(h.hostname).toBe("laptop");
    expect(h.gpus).toHaveLength(32);
    expect("extra" in h).toBe(false);
  });

  it("is refused without what it must carry", () => {
    expect(parseHello({ ...hello, type: "policy" })).toMatch(/first message/);
    expect(parseHello({ ...hello, nonce: "short" })).toMatch(/nonce/);
    expect(parseHello({ ...hello, policy: { ...policy, updates: "sometimes" } })).toMatch(/policy/);
    expect(parseHello({ ...hello, protocol: "1" })).toMatch(/protocol/);
  });
});

describe("the revoked signature", () => {
  const token = `abn_${"t".repeat(43)}`;
  const nonce = "n".repeat(43);
  it("verifies for this token, machine and link only", () => {
    const mac = revokeMac(tokenDigest(token), "m1", nonce);
    expect(verifyRevoke(token, "m1", nonce, mac)).toBe(true);
    expect(verifyRevoke(token, "m2", nonce, mac)).toBe(false);
    expect(verifyRevoke(token, "m1", "o".repeat(43), mac)).toBe(false);
    expect(verifyRevoke(`abn_${"u".repeat(43)}`, "m1", nonce, mac)).toBe(false);
    expect(verifyRevoke(token, "m1", nonce, undefined)).toBe(false);
    expect(verifyRevoke(token, "m1", nonce, "zz")).toBe(false);
  });
});
