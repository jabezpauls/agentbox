import { Globe, KeyRound, Lock } from "lucide-react";
import { formatUntil } from "../lib/format.ts";
import { isPublic, type AppView } from "./model.ts";

/** Who can open an app: private, anyone with the link, or with a passcode — and until when. */
export function VisibilityBadge({ app, now = Date.now() }: { app: AppView; now?: number }) {
  const v = app.visibility;
  if (!isPublic(app, now)) {
    return (
      <span className="pill vis-badge is-private" title="Only you, signed in">
        <Lock size={11} aria-hidden="true" />
        Private
      </span>
    );
  }
  const until = v.expiresAt ? formatUntil(v.expiresAt, now).replace(/^in /, "") : null;
  const Icon = v.mode === "passcode" ? KeyRound : Globe;
  const label = v.mode === "passcode" ? "Passcode" : "Public";
  return (
    <span
      className="pill vis-badge is-public"
      title={`${v.mode === "passcode" ? "Anyone with the link and the passcode" : "Anyone with the link"}${until ? `, for ${until} more` : ", until you stop sharing"}`}
    >
      <Icon size={11} aria-hidden="true" />
      {label}
      {until && <span className="vis-until">· {until}</span>}
    </span>
  );
}

/** Whether something answers on the app's port. */
export function LiveBadge({ app }: { app: AppView }) {
  return (
    <span className={`pill live-badge ${app.listening ? "is-live" : "is-down"}`}>
      <span className="pill-dot" aria-hidden="true" />
      {app.listening ? "Running" : "Not running"}
    </span>
  );
}
