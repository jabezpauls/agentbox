import { create } from "zustand";

/** More than any sane copy; an OSC 52 beyond it is dropped rather than decoded. */
export const OSC52_MAX_BYTES = 1024 * 1024;

/**
 * What an OSC 52 sequence (`ESC ] 52 ; <targets> ; <payload> BEL`) asks for,
 * given the text after `52;`: `write` a copy to the clipboard, or `read` it
 * back — which a program in the box never gets, since that would hand it
 * whatever the viewer last copied anywhere. Anything else is `null`.
 */
export function parseOsc52(data: string): { write: string } | "read" | null {
  const semi = data.indexOf(";");
  if (semi < 0) return null;
  const payload = data.slice(semi + 1);
  if (payload === "?") return "read";
  if (payload.length > (OSC52_MAX_BYTES * 4) / 3 + 4) return null;
  try {
    const bin = atob(payload);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return { write: new TextDecoder("utf-8", { fatal: false }).decode(bytes) };
  } catch {
    return null;
  }
}

export type ClipboardKey = "copy" | "paste" | null;

/**
 * The terminal's own copy and paste keys: Ctrl+Shift+C and Ctrl+Shift+V
 * everywhere, and on a Mac ⌘C (while text is selected) and ⌘V. Plain Ctrl+C
 * stays the shell's interrupt; ⌘C with nothing selected is left alone.
 */
export function clipboardKey(
  e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
  mac: boolean,
  hasSelection: boolean,
): ClipboardKey {
  const k = e.code === "KeyC" || e.key.toLowerCase() === "c" ? "c" : e.code === "KeyV" || e.key.toLowerCase() === "v" ? "v" : null;
  if (!k || e.altKey) return null;
  if (e.ctrlKey && e.shiftKey && !e.metaKey) return k === "c" ? "copy" : "paste";
  if (mac && e.metaKey && !e.ctrlKey && !e.shiftKey) {
    if (k === "c") return hasSelection ? "copy" : null;
    return "paste";
  }
  return null;
}

/** Put `text` on the clipboard, quietly: a denied write is not worth an error. */
export function writeClipboard(text: string): void {
  if (!text) return;
  navigator.clipboard?.writeText(text).catch(() => {});
}

const KEY = "agentbox.terminalCopyOnSelect";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

/**
 * Whether selecting text in a terminal copies it at once, as herdr's own TUI
 * does (Settings → Appearance). On by default; kept in this browser.
 */
export const useCopyOnSelect = create<{ on: boolean; set(on: boolean): void }>((set) => ({
  on: read(),
  set(on) {
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch {
      // Best-effort: the choice still holds for this session.
    }
    set({ on });
  },
}));
