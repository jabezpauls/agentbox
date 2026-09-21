import { useEffect, useState } from "react";
import { useApp } from "../../store/app.ts";
import { call } from "../../api/call.ts";
import { Dialog } from "./Dialog.tsx";

type Target = "workspace" | "tab" | "pane";
const METHOD: Record<Target, { method: string; key: string; noun: string }> = {
  workspace: { method: "workspace.rename", key: "workspace_id", noun: "workspace" },
  tab: { method: "tab.rename", key: "tab_id", noun: "tab" },
  pane: { method: "pane.rename", key: "pane_id", noun: "pane" },
};

/** Rename a workspace, tab or pane. Opened via the store's `rename` dialog. */
export function RenameDialog() {
  const dialog = useApp((s) => s.ui.dialog);
  const setUi = useApp((s) => s.setUi);
  const [value, setValue] = useState("");

  const open = dialog?.kind === "rename";
  const target = open ? (dialog!.target as Target) : "workspace";
  const id = open ? (dialog!.id as string) : "";

  useEffect(() => {
    if (open) setValue(String(dialog!.label ?? ""));
  }, [open, dialog]);

  if (!open) return null;

  const close = () => setUi({ dialog: null });
  const submit = () => {
    const label = value.trim();
    const { method, key } = METHOD[target];
    if (label) void call(method, { [key]: id, label });
    close();
  };

  return (
    <Dialog title={`Rename ${METHOD[target].noun}`} onClose={close} onSubmit={submit} submitLabel="Rename" submitDisabled={!value.trim()}>
      <label className="field">
        <span className="field-label">Name</span>
        <input className="input" value={value} onChange={(e) => setValue(e.target.value)} aria-label="New name" />
      </label>
    </Dialog>
  );
}
