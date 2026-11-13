#!/usr/bin/env node
// Set a Windows executable's subsystem: 3 is a console program, 2 a GUI one
// (which Windows starts with no console window). The release's
// agentbox-node.exe is agentbox.exe with this one field changed (phase 0 of
// the machines spike), so the node's supervisor starts at logon with no window.
//
//   node scripts/pe-subsystem.mjs <in.exe> <out.exe> [gui|console]
//
// Every offset is read from the file's own headers, never assumed: the DOS
// header's e_lfanew gives the PE signature, the COFF header after it the
// optional header's size, and the optional header's magic says PE32 or PE32+
// (Subsystem is 68 bytes in for both).
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const SUBSYSTEM = { gui: 2, console: 3 };

/** Where the Subsystem field is in this PE image, checking each header on the way. */
export function subsystemOffset(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error("not a Windows executable (no MZ header)");
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) throw new Error("not a PE image (no PE signature where e_lfanew points)");
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  if (optSize < 70 || opt + optSize > buf.length) throw new Error("the PE optional header is too short to hold a subsystem");
  const magic = buf.readUInt16LE(opt);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`unknown PE optional header magic 0x${magic.toString(16)}`);
  return opt + 68;
}

/**
 * A copy of `buf` with its subsystem set to `value`. Only a console or GUI
 * program is changed: anything else (a driver, EFI, …) is not what we built.
 */
export function setSubsystem(buf, value) {
  const at = subsystemOffset(buf);
  const was = buf.readUInt16LE(at);
  if (was !== SUBSYSTEM.console && was !== SUBSYSTEM.gui) throw new Error(`unexpected subsystem ${was}: not a console or GUI program`);
  const out = Buffer.from(buf);
  out.writeUInt16LE(value, at);
  return { out, offset: at, was };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output, kind = "gui"] = process.argv.slice(2);
  if (!input || !output || !(kind in SUBSYSTEM)) {
    console.error("usage: pe-subsystem.mjs <in.exe> <out.exe> [gui|console]");
    process.exit(2);
  }
  try {
    const { out, offset, was } = setSubsystem(fs.readFileSync(input), SUBSYSTEM[kind]);
    fs.writeFileSync(output, out);
    console.log(`${output}: subsystem ${was} -> ${SUBSYSTEM[kind]} at 0x${offset.toString(16)}`);
  } catch (err) {
    console.error(`pe-subsystem: ${input}: ${err.message}`);
    process.exit(1);
  }
}
