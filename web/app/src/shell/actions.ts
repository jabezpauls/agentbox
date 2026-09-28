import { useApp } from "../store/app.ts";
import { chordAction, GoSequence, isBareKey, isMacPlatform, isPaletteKey, type KeyLike, type ShellAction } from "./keys.ts";
import { useRouter } from "./router.ts";
import { openModal } from "./activity.tsx";

/** Open or close the dock on the current surface. */
export function toggleDock(open?: boolean): void {
  const s = useApp.getState();
  s.setInspector({ open: open ?? !s.ui.inspector.open });
}

/** Open the dock on a panel. */
export function showDock(tab: "preview" | "review"): void {
  useApp.getState().setInspector({ open: true, tab });
}

export function openPalette(mode = "all"): void {
  useApp.getState().setUi({ palette: { mode }, dialog: null });
}

export function openKeymap(): void {
  useApp.getState().setUi({ dialog: { kind: "keymap" }, palette: null });
}

export function runShellAction(a: ShellAction): void {
  switch (a.kind) {
    case "palette":
      openPalette();
      break;
    case "go":
      useApp.getState().setUi({ palette: null });
      useRouter.getState().go(a.surface);
      break;
    case "dock":
      toggleDock();
      break;
    case "keymap":
      openKeymap();
      break;
  }
}

const mac = isMacPlatform();

/**
 * The ⌃⌥ chords, for places that see keys before the window does — a
 * terminal's key handler, the editor's frame. True when the key was taken.
 */
export function handleChord(e: KeyboardEvent | KeyLike): boolean {
  const action = chordAction(e, mac);
  if (!action) return false;
  runShellAction(action);
  return true;
}

export const goSequence = new GoSequence();

/** True when a key belongs to a text field, or to a terminal's hidden input. */
export function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

/**
 * The window-level half of the shell's keyboard (see keys.ts): chords from
 * anywhere, ⌘K, and — when nothing is being typed into and no overlay is
 * open — `?` and the `g` sequences. Returns true when it took the key.
 */
export function handleShellKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return false;
  if (handleChord(e)) {
    e.preventDefault();
    return true;
  }
  if (isPaletteKey(e)) {
    e.preventDefault();
    openPalette();
    return true;
  }
  if (isTextEntry(e.target) || !isBareKey(e)) return false;
  const { ui } = useApp.getState();
  if (ui.palette || ui.dialog || openModal()) return false;
  if (e.key === "?") {
    e.preventDefault();
    openKeymap();
    return true;
  }
  const r = goSequence.feed(e.key);
  if (r.surface) useRouter.getState().go(r.surface);
  if (r.consumed) e.preventDefault();
  return r.consumed;
}
