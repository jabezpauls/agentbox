import type { FileEntry } from "@workbench/shared";
import { download, filesApi, rawUrl, zipUrl } from "../../files/api.ts";
import { basename, dirname, freeName, join, nameProblem, splitExt } from "../../files/paths.ts";
import { confirm, promptText } from "../../components/ui/prompts.tsx";
import { toast, toastError } from "../../shell/toast.ts";
import { plural } from "../../lib/format.ts";

/**
 * What Files does to files, each ending in a toast that says what happened —
 * and, where it can be taken back, an Undo. Nothing here deletes outright:
 * "delete" is the trash, and only the trash view deletes for good.
 */

/** Entries the Files surface is showing, for the actions that need names or types. */
export type Changed = () => void;

function names(paths: string[]): string {
  return paths.length === 1 ? basename(paths[0]!) : plural(paths.length, "item");
}

export async function moveToTrash(paths: string[], onChange: Changed): Promise<void> {
  if (paths.length === 0) return;
  try {
    const { trashed } = await filesApi.trash(paths);
    onChange();
    if (trashed.length === 0) return;
    toast("success", `Moved ${names(trashed.map((t) => t.originalPath))} to the trash.`, undefined, {
      dedupe: `trash:${trashed.map((t) => t.id).join(",")}`,
      action: {
        label: "Undo",
        run: () => {
          void Promise.all(trashed.map((t) => filesApi.restore(t.id)))
            .then(() => {
              onChange();
              toast("info", `Put ${names(trashed.map((t) => t.originalPath))} back.`);
            })
            .catch((err) => toastError("Couldn't put it back.", err));
        },
      },
    });
  } catch (err) {
    toastError(`Couldn't move ${names(paths)} to the trash.`, err, () => void moveToTrash(paths, onChange));
    onChange();
  }
}

export async function rename(entry: FileEntry, name: string, onChange: (to: string) => void): Promise<boolean> {
  const problem = nameProblem(name);
  if (problem) {
    toast("error", "Couldn't rename it.", problem);
    return false;
  }
  if (name === entry.name) return true;
  const to = join(dirname(entry.path), name);
  try {
    await filesApi.move(entry.path, to);
    onChange(to);
    return true;
  } catch (err) {
    toastError(`Couldn't rename ${entry.name}.`, err);
    return false;
  }
}

/** Move (or with `copy`, copy) paths into a folder, with an Undo for a move. */
export async function moveInto(paths: string[], folder: string, onChange: Changed, copy = false): Promise<void> {
  const todo = paths.filter((p) => dirname(p) !== folder && p !== folder && !folder.startsWith(`${p}/`));
  if (todo.length === 0) return;
  const done: { from: string; to: string }[] = [];
  let failure: unknown = null;
  for (const from of todo) {
    const to = join(folder, basename(from));
    try {
      if (copy) await filesApi.copy(from, to);
      else await filesApi.move(from, to);
      done.push({ from, to });
    } catch (err) {
      failure = err;
      break;
    }
  }
  onChange();
  if (done.length) {
    const verb = copy ? "Copied" : "Moved";
    toast("success", `${verb} ${names(done.map((d) => d.from))} to ${basename(folder)}.`, undefined, copy
      ? {}
      : {
          action: {
            label: "Undo",
            run: () =>
              void Promise.all(done.map((d) => filesApi.move(d.to, d.from)))
                .then(onChange)
                .catch((err) => toastError("Couldn't move it back.", err)),
          },
        });
  }
  if (failure) toastError(`Couldn't ${copy ? "copy" : "move"} ${basename(todo[done.length]!)}.`, failure);
}

export async function duplicate(entry: FileEntry, taken: Set<string>, onChange: (to: string) => void): Promise<void> {
  const to = join(dirname(entry.path), freeName(entry.name, taken));
  try {
    await filesApi.copy(entry.path, to);
    onChange(to);
  } catch (err) {
    toastError(`Couldn't duplicate ${entry.name}.`, err);
  }
}

export async function newFolder(dir: string, taken: Set<string>, onChange: (path: string) => void): Promise<void> {
  let initial = "New folder";
  for (let n = 2; taken.has(initial); n++) initial = `New folder ${n}`;
  const name = await promptText({
    title: "New folder",
    label: "Name",
    initial,
    confirmLabel: "Create",
    validate: (v) => nameProblem(v) ?? (taken.has(v) ? "Something here already has that name." : null),
  });
  if (!name) return;
  try {
    const entry = await filesApi.mkdir(join(dir, name));
    onChange(entry.path);
  } catch (err) {
    toastError("Couldn't make the folder.", err);
  }
}

export async function newFile(dir: string, taken: Set<string>, onChange: (path: string) => void): Promise<void> {
  const name = await promptText({
    title: "New file",
    label: "Name",
    initial: "untitled.txt",
    selectTo: splitExt("untitled.txt")[0].length,
    confirmLabel: "Create",
    validate: (v) => nameProblem(v) ?? (taken.has(v) ? "Something here already has that name." : null),
  });
  if (!name) return;
  try {
    const entry = await filesApi.write(join(dir, name), "");
    onChange(entry.path);
  } catch (err) {
    toastError("Couldn't make the file.", err);
  }
}

/** One file downloads as itself; a folder or several things as a zip. */
export function downloadPaths(entries: FileEntry[], folderName: string): void {
  if (entries.length === 1 && entries[0]!.type === "file") {
    download(rawUrl(entries[0]!.path));
    return;
  }
  const name = entries.length === 1 ? `${entries[0]!.name}.zip` : `${folderName}.zip`;
  download(zipUrl(entries.map((e) => e.path), name));
}

export async function copyPaths(paths: string[]): Promise<void> {
  try {
    await navigator.clipboard.writeText(paths.join("\n"));
    toast("info", paths.length === 1 ? "Copied the path." : `Copied ${paths.length} paths.`, paths.length === 1 ? paths[0] : undefined);
  } catch {
    toast("error", "Couldn't copy to the clipboard.", "The browser did not allow it here.");
  }
}

export async function restoreFromTrash(ids: string[], onChange: Changed): Promise<void> {
  let restored = 0;
  for (const id of ids) {
    try {
      await filesApi.restore(id);
      restored++;
    } catch (err) {
      toastError("Couldn't restore it.", err);
    }
  }
  onChange();
  if (restored) toast("success", restored === 1 ? "Restored 1 item." : `Restored ${restored} items.`);
}

export async function deleteForever(ids: string[], label: string, onChange: Changed): Promise<void> {
  const ok = await confirm({
    title: ids.length === 1 ? `Delete ${label} for good?` : `Delete ${ids.length} items for good?`,
    body: "They are removed from the trash and cannot be restored.",
    confirmLabel: "Delete",
  });
  if (!ok) return;
  for (const id of ids) {
    try {
      await filesApi.removeFromTrash(id);
    } catch (err) {
      toastError("Couldn't delete it.", err);
    }
  }
  onChange();
}

export async function emptyTrash(count: number, onChange: Changed): Promise<void> {
  const ok = await confirm({
    title: "Empty the trash?",
    body: `${plural(count, "item")} will be deleted for good. This cannot be undone.`,
    confirmLabel: "Empty trash",
  });
  if (!ok) return;
  try {
    const { removed } = await filesApi.emptyTrash();
    toast("success", removed === 1 ? "Deleted 1 item for good." : `Deleted ${removed} items for good.`);
  } catch (err) {
    toastError("Couldn't empty the trash.", err);
  }
  onChange();
}
