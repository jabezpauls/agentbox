import { useEffect, useState } from "react";
import { ChevronRight, Folder } from "lucide-react";
import type { DirEntry } from "@workbench/shared";
import { useApp } from "../../store/app.ts";
import { listDirs } from "../../api/client.ts";
import { call } from "../../api/call.ts";
import { Dialog } from "./Dialog.tsx";

/** Join the workspace root with a picker-relative path into an absolute cwd. */
function absolute(root: string, rel: string): string {
  if (!rel) return root;
  return `${root.replace(/\/+$/, "")}/${rel}`;
}

/**
 * Create a workspace from a directory picker confined to the workspace root,
 * optionally as a git worktree. The picker lists subdirectories from the
 * bridge; double-clicking descends and the breadcrumb climbs back. herdr's own
 * helpers do the work: `worktree.create` or `workspace.create`.
 */
export function NewWorkspaceDialog() {
  const dialog = useApp((s) => s.ui.dialog);
  const setUi = useApp((s) => s.setUi);
  const root = useApp((s) => s.health?.workspaceRoot ?? "/workspace");

  const open = dialog?.kind === "workspace.new";
  const [label, setLabel] = useState("");
  const [rel, setRel] = useState("");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [worktree, setWorktree] = useState(false);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");

  useEffect(() => {
    if (!open) return;
    setLabel("");
    setRel("");
    setError(null);
    setWorktree(Boolean(dialog!.worktree));
    setBranch("");
    setBase("");
  }, [open, dialog]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    listDirs(rel)
      .then((e) => live && (setEntries(e), setError(null)))
      .catch(() => live && (setEntries([]), setError("Cannot read this folder")));
    return () => {
      live = false;
    };
  }, [open, rel]);

  if (!open) return null;

  const cwd = absolute(root, rel);
  const crumbs = rel ? rel.split("/") : [];
  const close = () => setUi({ dialog: null });

  const submit = () => {
    const name = label.trim();
    if (worktree) {
      void call("worktree.create", { cwd, branch: branch.trim() || undefined, base: base.trim() || undefined, label: name || undefined, focus: true });
    } else {
      void call("workspace.create", { cwd, label: name || undefined, focus: true });
    }
    close();
  };

  return (
    <Dialog title="New workspace" onClose={close} onSubmit={submit} submitLabel={worktree ? "Create worktree" : "Create workspace"}>
      <label className="field">
        <span className="field-label">Label</span>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Optional" aria-label="Workspace label" />
      </label>

      <div className="field">
        <span className="field-label">Folder</span>
        <div className="crumbs">
          <button className="crumb" onClick={() => setRel("")}>
            {root}
          </button>
          {crumbs.map((seg, i) => (
            <span className="crumb-part" key={i}>
              <ChevronRight size={12} className="crumb-sep" />
              <button className="crumb" onClick={() => setRel(crumbs.slice(0, i + 1).join("/"))}>
                {seg}
              </button>
            </span>
          ))}
        </div>
        <ul className="dir-list" role="listbox" aria-label="Subdirectories">
          {entries.length === 0 && <li className="dir-empty">{error ?? "No subfolders"}</li>}
          {entries.map((e) => (
            <li key={e.path}>
              {/* Double-click descends with the mouse; Enter/Space on the
                  focused row (detail 0) does the same from the keyboard. */}
              <button className="dir-item" onDoubleClick={() => setRel(e.path)} onClick={(ev) => ev.detail === 0 && setRel(e.path)}>
                <Folder size={14} />
                <span>{e.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="dir-current" onClick={submit}>
          Use this folder: <code>{cwd}</code>
        </button>
      </div>

      <label className="check">
        <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
        <span>Create a git worktree</span>
      </label>
      {worktree && (
        <div className="field-row">
          <label className="field">
            <span className="field-label">Branch</span>
            <input className="input" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="new-branch" aria-label="Branch" />
          </label>
          <label className="field">
            <span className="field-label">Base</span>
            <input className="input" value={base} onChange={(e) => setBase(e.target.value)} placeholder="main" aria-label="Base" />
          </label>
        </div>
      )}
    </Dialog>
  );
}
