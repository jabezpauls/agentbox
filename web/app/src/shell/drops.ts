import { carriesFiles } from "../files/drop.ts";

/**
 * Files dragged in from the desktop and let go anywhere the app does not
 * take them. Left alone, the browser opens the file in place of the app — a
 * PDF dropped a few pixels off the list navigated the whole box away. Here a
 * drop nobody claimed is cancelled, and the cursor says no over places that
 * do not take files. Files claims its own (anywhere on the surface uploads
 * into the folder shown); the editor's frame is its own document and keeps
 * its own drops.
 */
export function installDropGuard(target: Window = window): () => void {
  const over = (e: DragEvent) => {
    if (e.defaultPrevented || !carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  const drop = (e: DragEvent) => {
    if (e.defaultPrevented || !carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
  };
  target.addEventListener("dragover", over);
  target.addEventListener("drop", drop);
  return () => {
    target.removeEventListener("dragover", over);
    target.removeEventListener("drop", drop);
  };
}
