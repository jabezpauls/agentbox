import { inflateRawSync } from "node:zlib";

/**
 * Just enough of a zip reader for herdr's Windows release (a plain zip of a
 * few files, stored or deflated): the node bundles no zip library. Nothing
 * from a zip is used unless its SHA-256 is pinned (install.ts), so this only
 * has to refuse what it does not understand, never to judge what it reads.
 */

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** No herdr file is anywhere near this; a bigger one is not herdr's. */
const MAX_FILE = 256 * 1024 * 1024;

export class ZipError extends Error {}

/** Every file in `zip`, by its name in the archive (`/`-separated). Folders are left out. */
export function unzip(zip: Buffer): Map<string, Buffer> {
  // The end record is in the last 64 KiB + 22 bytes (its comment is at most 64 KiB).
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError("not a zip file");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL) throw new ZipError("the zip's directory is damaged");
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const csize = zip.readUInt32LE(at + 20);
    const usize = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (flags & 0x1) throw new ZipError(`${name} is encrypted`);
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new ZipError(`${name} needs zip64, which this reader does not do`);
    if (usize > MAX_FILE) throw new ZipError(`${name} is larger than anything expected here`);
    if (name.startsWith("/") || name.includes("\\") || name.split("/").some((p) => p === ".." || p === "." || p === "" || p.includes(":"))) {
      throw new ZipError(`the zip names a file outside itself (${JSON.stringify(name)})`);
    }
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== LOCAL) throw new ZipError(`${name}: its local header is damaged`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + csize);
    if (data.length !== csize) throw new ZipError(`${name} is cut short`);
    let bytes: Buffer;
    if (method === 0) bytes = Buffer.from(data);
    else if (method === 8) bytes = inflateRawSync(data, { maxOutputLength: MAX_FILE });
    else throw new ZipError(`${name} is compressed in a way this reader does not do (method ${method})`);
    if (bytes.length !== usize) throw new ZipError(`${name} did not unpack to its size`);
    out.set(name, bytes);
  }
  return out;
}
