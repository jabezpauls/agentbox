import { Globe, KeyRound, Lock } from "lucide-react";
import { formatUntil } from "../lib/format.ts";
import { isCrashed, isPublic, type AppView } from "./model.ts";

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

/**
 * When nothing answers on the app's port: a quiet "Not running", or a warning
 * for a pinned app that should be. A running app shows no badge — its light
 * says so, and the row names the process.
 */
export function LiveBadge({ app }: { app: AppView }) {
  if (app.live.listening) return <span className="sr-only">Running</span>;
  const crashed = isCrashed(app);
  return (
    <span className={`pill live-badge ${crashed ? "is-crashed" : "is-down"}`} title={crashed ? "Pinned to run with the box, but nothing is serving" : undefined}>
      <span className="pill-dot" aria-hidden="true" />
      Not running
    </span>
  );
}
