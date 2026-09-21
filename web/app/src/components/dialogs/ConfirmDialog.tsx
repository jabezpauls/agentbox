import { useApp } from "../../store/app.ts";
import { rpc } from "../../api/client.ts";
import { Dialog } from "./Dialog.tsx";

/**
 * Confirm closing a pane or tab that hosts a working or blocked agent, so an
 * active agent is never dropped by a stray keystroke. Idle panes never reach
 * here — the action closes them directly.
 */
export function ConfirmDialog() {
  const dialog = useApp((s) => s.ui.dialog);
  const setUi = useApp((s) => s.setUi);

  const isPane = dialog?.kind === "confirm.close-pane";
  const isTab = dialog?.kind === "confirm.close-tab";
  if (!isPane && !isTab) return null;

  const title = String(dialog!.title ?? (isPane ? "pane" : "tab"));
  const close = () => setUi({ dialog: null });
  const confirm = () => {
    if (isPane) rpc("pane.close", { pane_id: dialog!.paneId as string }).catch(() => {});
    else rpc("tab.close", { tab_id: dialog!.tabId as string }).catch(() => {});
    close();
  };

  return (
    <Dialog
      title={isPane ? "Close pane?" : "Close tab?"}
      onClose={close}
      onSubmit={confirm}
      submitLabel={isPane ? "Close pane" : "Close tab"}
      danger
    >
      <p className="dialog-text">
        <strong>{title}</strong> has a running agent. Closing it will end the agent's session.
      </p>
    </Dialog>
  );
}
