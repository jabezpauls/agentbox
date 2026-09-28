import { useState } from "react";
import { Dialog } from "../components/dialogs/Dialog.tsx";
import { SharePanel } from "../components/PreviewPanel.tsx";
import { useApp } from "../store/app.ts";
import type { AppView } from "./model.ts";

/**
 * Share an app from the Apps surface: the Preview panel's own share controls
 * (who may open it, for how long, a passcode typed or made), in a dialog, so
 * both places share one way of doing it.
 */
export function ShareDialog({ app, onClose }: { app: AppView; onClose(): void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(key);
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
      },
      () => {},
    );
  // The panel works from the live record, so what it shows follows a change.
  const live = useApp((s) => s.apps?.find((a) => a.id === app.id)) ?? app;
  return (
    <Dialog title={`Share ${app.name}`} onClose={onClose} cancelLabel="Done">
      <SharePanel app={live} copied={copied} onCopy={copy} onChanged={() => void useApp.getState().refreshApps()} onClose={onClose} />
    </Dialog>
  );
}
