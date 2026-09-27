import { create } from "zustand";
import type { EditorOpenResult } from "@workbench/shared";
import { http } from "../api/http.ts";
import { useRouter } from "./router.ts";
import { toast, toastError } from "./toast.ts";

/** How long the bridge may wait for an editor that is still starting up. */
const WAIT_MS = 25_000;

/** What the editor surface is being asked to show, for its progress line. */
export const useEditorState = create<{ opening: string | null }>(() => ({ opening: null }));

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
    const res = await http.post<EditorOpenResult>("/api/editor/open", { path, ...at, wait: WAIT_MS });
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
