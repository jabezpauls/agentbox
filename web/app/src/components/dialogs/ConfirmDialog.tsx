import { useApp } from "../../store/app.ts";
import { call } from "../../api/call.ts";
import { Dialog } from "./Dialog.tsx";

interface Shape {
  heading: string;
  submit: string;
  idKey: string;
  method: string;
  paramKey: string;
  body(title: string): string;
}

const SHAPES: Record<string, Shape> = {
  "confirm.close-pane": {
    heading: "Close pane?",
    submit: "Close pane",
    idKey: "paneId",
    method: "pane.close",
    paramKey: "pane_id",
    body: () => "has a running agent. Closing it will end the agent's session.",
  },
  "confirm.close-tab": {
    heading: "Close tab?",
    submit: "Close tab",
    idKey: "tabId",
    method: "tab.close",
    paramKey: "tab_id",
    body: () => "has a running agent. Closing it will end the agent's session.",
  },
  "confirm.close-workspace": {
    heading: "Close workspace?",
    submit: "Close workspace",
    idKey: "workspaceId",
    method: "workspace.close",
    paramKey: "workspace_id",
    body: () => "will be closed, ending every tab, pane and agent inside it.",
  },
};

/**
 * Confirm a destructive close. Panes and tabs only reach here when they host a
 * working or blocked agent; a workspace always does, because closing one takes
 * every tab and agent in it with a single keystroke.
 */
export function ConfirmDialog() {
  const dialog = useApp((s) => s.ui.dialog);
  const setUi = useApp((s) => s.setUi);

  const shape = dialog ? SHAPES[dialog.kind] : undefined;
  if (!dialog || !shape) return null;

  const title = String(dialog.title ?? "this");
  const close = () => setUi({ dialog: null });
  const confirm = () => {
    void call(shape.method, { [shape.paramKey]: dialog[shape.idKey] as string });
    close();
  };

  return (
    <Dialog title={shape.heading} onClose={close} onSubmit={confirm} submitLabel={shape.submit} danger>
      <p className="dialog-text">
        <strong>{title}</strong> {shape.body(title)}
      </p>
    </Dialog>
  );
}
