// Translate a browser KeyboardEvent into the key-combo strings herdr uses in
// its keymap, e.g. "ctrl+b", "shift+n", "minus", "?", "1", "enter", "esc".

// Named keys whose combo token differs from their `key` value.
const NAMED: Record<string, string> = {
  Escape: "esc",
  Enter: "enter",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  " ": "space",
  "-": "minus",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

function baseToken(key: string): string {
  if (key in NAMED) return NAMED[key]!;
  // Everything else lower-cases, so "N" and "n" match the same binding and
  // "F5"/"f5" agree; shift is carried separately (see below).
  return key.toLowerCase();
}

/**
 * Produce a canonical combo string. Modifiers are emitted in a fixed order
 * (ctrl, alt, shift, meta). Shift is only recorded for alphabetic keys: a
 * shifted symbol like "?" already encodes the shift in its glyph, so adding a
 * `shift+` prefix there would never match herdr's map.
 */
export function comboFromEvent(e: KeyboardEvent): string {
  const base = baseToken(e.key);
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey && /^[a-z]$/.test(base)) parts.push("shift");
  if (e.metaKey) parts.push("meta");
  parts.push(base);
  return parts.join("+");
}
