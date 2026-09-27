/**
 * Filenames are bytes, the API speaks text.
 *
 * A Linux filename is any byte string without `/` or NUL, and nothing makes it
 * valid UTF-8 — an archive unpacked from another system, or a test fixture,
 * produces names Node would silently decode to U+FFFD. Such a name can then be
 * listed but never opened, renamed or deleted again: the replacement character
 * is not the byte it replaced.
 *
 * The files API therefore carries names the way Python's `surrogateescape`
 * does. A byte that is not part of a valid UTF-8 sequence becomes the lone low
 * surrogate U+DC80 + (byte − 0x80). Valid UTF-8 can never decode to a lone
 * surrogate, so the mapping is unambiguous and every name round-trips exactly.
 * JSON carries lone surrogates as `\udcXX` escapes; a query string carries the
 * original bytes percent-encoded (see {@link encodePathParam} in the shared
 * package, and {@link parseQuery} here).
 */

const strict = new TextDecoder("utf-8", { fatal: true });

/** Decode raw filename bytes, escaping any byte that is not valid UTF-8. */
export function decodeName(bytes: Uint8Array): string {
  try {
    return strict.decode(bytes);
  } catch {
    return decodeLossless(bytes);
  }
}

function decodeLossless(b: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < b.length) {
    const c = b[i]!;
    if (c < 0x80) {
      out += String.fromCharCode(c);
      i += 1;
      continue;
    }
    const len = sequenceLength(b, i);
    if (len === 0) {
      out += String.fromCharCode(0xdc00 + c);
      i += 1;
      continue;
    }
    out += strict.decode(b.subarray(i, i + len));
    i += len;
  }
  return out;
}

/**
 * The length of the well-formed UTF-8 sequence starting at `i`, or 0 when the
 * byte there does not start one (per the Unicode table of well-formed byte
 * sequences: no overlongs, no surrogates, nothing above U+10FFFF).
 */
function sequenceLength(b: Uint8Array, i: number): number {
  const c = b[i]!;
  const cont = (k: number, lo = 0x80, hi = 0xbf): boolean => {
    const v = b[i + k];
    return v !== undefined && v >= lo && v <= hi;
  };
  if (c >= 0xc2 && c <= 0xdf) return cont(1) ? 2 : 0;
  if (c === 0xe0) return cont(1, 0xa0) && cont(2) ? 3 : 0;
  if ((c >= 0xe1 && c <= 0xec) || c === 0xee || c === 0xef) return cont(1) && cont(2) ? 3 : 0;
  if (c === 0xed) return cont(1, 0x80, 0x9f) && cont(2) ? 3 : 0;
  if (c === 0xf0) return cont(1, 0x90) && cont(2) && cont(3) ? 4 : 0;
  if (c >= 0xf1 && c <= 0xf3) return cont(1) && cont(2) && cont(3) ? 4 : 0;
  if (c === 0xf4) return cont(1, 0x80, 0x8f) && cont(2) && cont(3) ? 4 : 0;
  return 0;
}

/** True when `s` holds a lone surrogate, i.e. an escaped byte. */
export function hasEscapes(s: string): boolean {
  // With the `u` flag a surrogate pair is one code point, so only a lone half
  // matches the surrogate category.
  return /\p{Cs}/u.test(s);
}

/** Thrown for a string that names no byte sequence at all. */
export class NameError extends Error {}

/** The exact bytes a (possibly escaped) name stands for. */
export function encodeName(s: string): Buffer {
  if (!hasEscapes(s)) return Buffer.from(s, "utf8");
  const parts: Buffer[] = [];
  let run = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xdc80 && cp <= 0xdcff) {
      if (run) parts.push(Buffer.from(run, "utf8"));
      run = "";
      parts.push(Buffer.from([cp - 0xdc00]));
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      // A lone surrogate outside the escape range was never produced by
      // decodeName and stands for no byte.
      throw new NameError("path contains an unpaired surrogate");
    } else {
      run += ch;
    }
  }
  if (run) parts.push(Buffer.from(run, "utf8"));
  return Buffer.concat(parts);
}

/**
 * The argument to hand Node's `fs` for a path: the string itself when it is
 * plain text (the common case), otherwise the exact bytes it stands for.
 */
export function fsPath(s: string): string | Buffer {
  return hasEscapes(s) ? encodeName(s) : s;
}

/** A display form of a name: escaped bytes shown as U+FFFD. */
export function displayName(s: string): string {
  return hasEscapes(s) ? s.replace(/\p{Cs}/gu, "�") : s;
}

/**
 * Parse a raw query string into repeated values, percent-decoding to bytes and
 * then through {@link decodeName}, so `?path=%FF` names the byte 0xFF rather
 * than U+FFFD. For ordinary UTF-8 this is exactly what a normal parser gives.
 */
export function parseQuery(rawUrl: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const q = rawUrl.indexOf("?");
  if (q === -1) return out;
  for (const pair of rawUrl.slice(q + 1).split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const key = decodeComponent(eq === -1 ? pair : pair.slice(0, eq));
    const value = eq === -1 ? "" : decodeComponent(pair.slice(eq + 1));
    const list = out.get(key);
    if (list) list.push(value);
    else out.set(key, [value]);
  }
  return out;
}

/** Percent-decode one URL component to bytes, then to an escaped string. */
export function decodeComponent(s: string, plusIsSpace = true): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 0x25 /* % */ && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (ch === 0x2b /* + */ && plusIsSpace) {
      bytes.push(0x20);
    } else if (ch < 0x80) {
      bytes.push(ch);
    } else {
      // A raw non-ASCII character in the URL: take its UTF-8 bytes.
      const cp = s.codePointAt(i)!;
      for (const b of Buffer.from(String.fromCodePoint(cp), "utf8")) bytes.push(b);
      if (cp > 0xffff) i += 1;
    }
  }
  return decodeName(Uint8Array.from(bytes));
}

/** Percent-encode an escaped string's exact bytes, for a URL path segment. */
export function encodeSegment(s: string): string {
  let out = "";
  for (const b of encodeName(s)) {
    const c = String.fromCharCode(b);
    // Only unreserved characters go out literally: a `;` or a backslash in a
    // name must not reach a path guard as the character itself.
    out += /[A-Za-z0-9\-._~]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}
