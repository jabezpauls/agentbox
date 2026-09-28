import { create } from "zustand";

const KEY = "agentbox.editorFollowsTheme";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

/**
 * Whether the editor follows the app's light or dark (Settings →
 * Appearance). On by default; kept in this browser, like the theme itself.
 * Off, the app stops telling the editor its theme at all.
 */
export const useEditorFollowsTheme = create<{ on: boolean; set(on: boolean): void }>((set) => ({
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
