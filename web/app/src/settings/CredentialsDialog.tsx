import { useState, type ReactNode } from "react";
import { Dialog } from "../components/dialogs/Dialog.tsx";
import { UsernameHint } from "../components/ui/UsernameHint.tsx";
import type { Credentials } from "./gate.ts";

interface Props {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  /** Ask for a two-factor code as well. */
  twoFactor: boolean;
  danger?: boolean;
  /** Do the thing; resolve to a sentence to show when it was refused, or null when done. */
  onSubmit(c: Credentials): Promise<string | null>;
  onClose(): void;
}

/**
 * "Confirm it is you": the password — and the code from the authenticator,
 * with two-factor on — asked for in the moment, sent with the one request
 * that needs it and then forgotten.
 */
export function CredentialsDialog({ title, body, confirmLabel, twoFactor, danger, onSubmit, onClose }: Props) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (!password) return setError("Enter your password.");
    if (twoFactor && !code.trim()) return setError("Enter the 6-digit code from your authenticator app.");
    setBusy(true);
    setError(null);
    const problem = await onSubmit({ password, ...(twoFactor ? { code: code.trim() } : {}) });
    setBusy(false);
    if (problem) setError(problem);
  };

  return (
    <Dialog title={title} narrow danger={danger ?? false} onClose={onClose} onSubmit={() => void submit()} submitLabel={confirmLabel} submitDisabled={busy}>
      {body && <div className="dialog-text">{body}</div>}
      <UsernameHint />
      <label className="field">
        <span className="field-label">Password</span>
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          data-autofocus
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
        />
      </label>
      {twoFactor && (
        <label className="field">
          <span className="field-label">Two-factor code</span>
          <input
            className="input mono"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456 or a recovery code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setError(null);
            }}
          />
        </label>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
