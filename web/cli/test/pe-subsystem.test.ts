import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tmpDir } from "./helpers.js";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "pe-subsystem.mjs");

/**
 * The smallest file with real PE headers: a DOS header whose e_lfanew points
 * past a stub, the PE signature, a COFF header, and an optional header of the
 * given magic with its Subsystem 68 bytes in.
 */
function tinyPe(opts: { lfanew?: number; magic?: number; subsystem?: number; optSize?: number } = {}): { buf: Buffer; at: number } {
  const lfanew = opts.lfanew ?? 0x80;
  const optSize = opts.optSize ?? 0xf0;
  const buf = Buffer.alloc(lfanew + 24 + Math.max(optSize, 72) + 16);
  buf.write("MZ", 0, "latin1");
  buf.writeUInt32LE(lfanew, 0x3c);
  buf.write("PE\0\0", lfanew, "latin1");
  buf.writeUInt16LE(0x8664, lfanew + 4); // Machine: x64
  buf.writeUInt16LE(optSize, lfanew + 20); // SizeOfOptionalHeader
  buf.writeUInt16LE(opts.magic ?? 0x20b, lfanew + 24);
  const at = lfanew + 24 + 68;
  buf.writeUInt16LE(opts.subsystem ?? 3, at);
  return { buf, at };
}

function patch(input: Buffer, kind?: string): { status: number | null; out: Buffer | null; stderr: string } {
  const dir = tmpDir("agentbox-pe-");
  const src = path.join(dir, "in.exe");
  const dst = path.join(dir, "out.exe");
  fs.writeFileSync(src, input);
  const r = spawnSync(process.execPath, [script, src, dst, ...(kind ? [kind] : [])], { encoding: "utf8" });
  return { status: r.status, out: fs.existsSync(dst) ? fs.readFileSync(dst) : null, stderr: r.stderr };
}

describe("setting a Windows executable's subsystem", () => {
  it("changes console to GUI in that one field, found from the headers (PE32+ and PE32)", () => {
    for (const [lfanew, magic] of [
      [0x80, 0x20b],
      [0x108, 0x10b],
    ] as const) {
      const { buf, at } = tinyPe({ lfanew, magic });
      const r = patch(buf);
      expect(r.status, r.stderr).toBe(0);
      expect(r.out?.readUInt16LE(at)).toBe(2);
      // Every other byte is as it was.
      const back = Buffer.from(r.out as Buffer);
      back.writeUInt16LE(3, at);
      expect(back.equals(buf)).toBe(true);
    }
  });

  it("and back to console", () => {
    const { buf, at } = tinyPe({ subsystem: 2 });
    const r = patch(buf, "console");
    expect(r.status, r.stderr).toBe(0);
    expect(r.out?.readUInt16LE(at)).toBe(3);
  });

  it("refuses what is not a console or GUI PE image", () => {
    expect(patch(Buffer.from("\x7fELF not a PE file at all, padded out to sixty-four bytes long......")).stderr).toMatch(/no MZ header/);
    const noSig = tinyPe();
    noSig.buf.write("XX", 0x80, "latin1");
    expect(patch(noSig.buf).stderr).toMatch(/no PE signature/);
    expect(patch(tinyPe({ lfanew: 0x7ffff }).buf.subarray(0, 0x200)).stderr).toMatch(/no PE signature/);
    expect(patch(tinyPe({ magic: 0x107 }).buf).stderr).toMatch(/magic/);
    expect(patch(tinyPe({ optSize: 40 }).buf).stderr).toMatch(/too short/);
    const driver = patch(tinyPe({ subsystem: 1 }).buf);
    expect(driver.status).toBe(1);
    expect(driver.stderr).toMatch(/unexpected subsystem 1/);
    expect(driver.out).toBeNull();
  });
});
