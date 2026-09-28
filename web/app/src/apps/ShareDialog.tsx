import { useState } from "react";
import { Globe, KeyRound, Lock } from "lucide-react";
import { Dialog } from "../components/dialogs/Dialog.tsx";
import { errorText } from "../api/http.ts";
import { toast } from "../shell/toast.ts";
import { appsApi, isPublic, useApps, type AppView, type AppVisibilityMode } from "./model.ts";
import { defaultExpiry, EXPIRIES } from "./share.ts";

const MODES: { id: AppVisibilityMode; label: string; hint: string; icon: typeof Globe }[] = [
  { id: "private", label: "Private", hint: "Only you, signed in.", icon: Lock },
  { id: "link", label: "Anyone with the link", hint: "No sign-in. The link is the app's own URL.", icon: Globe },
  { id: "passcode", label: "Link and passcode", hint: "They type a passcode you choose, once.", icon: KeyRound },
];

/**
 * Share an app: who may open it, for how long, and — for a passcode — the
 * passcode. The link is the app's own URL, the one you were already looking
 * at; it is copied as soon as the app is public. Only the owner can do this;
 * an agent never can.
 */
export function ShareDialog({ app, onClose }: { app: AppView; onClose(): void }) {
  const shared = isPublic(app);
  const [mode, setMode] = useState<AppVisibilityMode>(shared ? app.visibility.mode : "link");
  const [expiry, setExpiry] = useState(defaultExpiry().id);
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const link = `${location.origin}${app.url}`;

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (mode === "passcode" && passcode && passcode.length < 4) return setError("A passcode is at least 4 characters.");
    if (mode === "passcode" && !passcode && app.visibility.mode !== "passcode") return setError("Choose a passcode.");
    setBusy(true);
    try {
      if (mode === "private") {
        await appsApi.unshare(app.id);
        toast("success", `${app.name} is private again.`, "Anyone still viewing was cut off.");
      } else {
        const seconds = EXPIRIES.find((e) => e.id === expiry)?.seconds ?? null;
        await appsApi.share(app.id, { mode, expiresIn: seconds, ...(mode === "passcode" && passcode ? { passcode } : {}) });
        const copied = await navigator.clipboard.writeText(link).then(
          () => true,
          () => false,
        );
        const how = EXPIRIES.find((e) => e.id === expiry)!;
        toast(
          "success",
          `${app.name} is public${how.seconds ? ` for ${how.label}` : " until you stop it"}.`,
          copied ? "The link is on your clipboard." : link,
        );
      }
      void useApps.getState().refresh();
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Share ${app.name}`}
      onClose={onClose}
      onSubmit={() => void submit()}
      submitLabel={mode === "private" ? (shared ? "Stop sharing" : "Keep private") : shared ? "Update" : "Share and copy link"}
      danger={mode === "private" && shared}
      submitDisabled={busy}
    >
      <div className="share-modes" role="radiogroup" aria-label="Who can open it">
        {MODES.map((m) => {
          const Icon = m.icon;
          return (
            <label key={m.id} className={`share-mode${mode === m.id ? " is-active" : ""}`}>
              <input type="radio" name="share-mode" value={m.id} checked={mode === m.id} onChange={() => setMode(m.id)} />
              <Icon size={16} aria-hidden="true" />
              <span className="share-mode-text">
                <strong>{m.label}</strong>
                <span>{m.hint}</span>
              </span>
            </label>
          );
        })}
      </div>
      {mode !== "private" && (
        <div className="field-row">
          <label className="field">
            <span className="field-label">For</span>
            <select className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {EXPIRIES.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>
          {mode === "passcode" && (
            <label className="field">
              <span className="field-label">Passcode</span>
              <input
                className="input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={app.visibility.mode === "passcode" ? "Keep the current one" : "At least 4 characters"}
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
              />
            </label>
          )}
        </div>
      )}
      <div className="field">
        <span className="field-label">Link</span>
        <code className="share-link">{link}</code>
        {mode !== "private" && (
          <span className="field-hint">Whoever has it can use the app as it runs, including anything the app itself can do. Stop sharing cuts them off at once.</span>
        )}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
