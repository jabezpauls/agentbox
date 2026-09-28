import { create } from "zustand";
import type { EditorOpenResult, EditorThemeKind } from "@workbench/shared";
import { http } from "../api/http.ts";
import { useRouter } from "./router.ts";
import { toast, toastError } from "./toast.ts";

/** How long the bridge may wait for an editor that is still starting up. */
const WAIT_MS = 25_000;

/**
 * What the editor surface is being asked to show, for its progress line, and
 * whether its frame has loaded yet.
 */
export const useEditorState = create<{ opening: string | null; frameLoaded: boolean }>(() => ({ opening: null, frameLoaded: false }));

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/**
 * "Open in editor", from anywhere: bring the editor forward — building its
 * frame if this is the first time — and ask the running editor to open the
 * file, at a line when given. The bridge holds the request until the
 * editor's extension has connected, so a cold start still lands on the file.
 */
export async function openInEditor(path: string, at: { line?: number; column?: number } = {}): Promise<void> {
  useRouter.getState().navigate({ surface: "editor" });
  useEditorState.setState({ opening: path });
  try {
    // `fresh`: the app has just brought its own editor frame forward, which
    // takes focus and so says "here I am" — the bridge waits a moment for
    // that rather than send the file to a closed tab's lingering window.
    // `starting`: the frame is still loading, so only a window that connects
    // from now on is this tab's.
    const starting = !useEditorState.getState().frameLoaded;
    const res = await http.post<EditorOpenResult>("/api/editor/open", { path, ...at, wait: WAIT_MS, fresh: true, starting });
    if (!res.delivered) {
      toast("error", `Couldn't open ${basename(path)} in the editor.`, res.error ? capitalise(res.error) : undefined, {
        retry: () => void openInEditor(path, at),
      });
    }
  } catch (err) {
    toastError(`Couldn't open ${basename(path)} in the editor.`, err, () => void openInEditor(path, at));
  } finally {
    if (useEditorState.getState().opening === path) useEditorState.setState({ opening: null });
  }
}

function capitalise(s: string): string {
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * Tell the editor the app's theme, resolved to light or dark, so VS Code
 * switches its color theme with the app — or null, to stop (Settings →
 * Appearance). Sent on every change and whenever the events socket comes
 * back (a restarted bridge has forgotten it).
 */
export async function followAppTheme(kind: EditorThemeKind | null): Promise<void> {
  try {
    await http.post("/api/editor/theme", { kind });
  } catch {
    // An older bridge, or none: the editor keeps its own theme.
  }
}
