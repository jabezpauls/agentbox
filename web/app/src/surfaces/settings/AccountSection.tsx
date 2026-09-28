import { useCallback, useState } from "react";
import { Check, Copy, Download, KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { errorText, HttpError } from "../../api/http.ts";
import { formatAgo } from "../../lib/format.ts";
import { Dialog } from "../../components/dialogs/Dialog.tsx";
import { Section } from "../../components/ui/Page.tsx";
import { confirm } from "../../components/ui/prompts.tsx";
import { usePolling } from "../../shell/activity.tsx";
import { signOut, useGateSession } from "../../shell/session.ts";
import { toast, toastError } from "../../shell/toast.ts";
import { CredentialsDialog } from "../../settings/CredentialsDialog.tsx";
import { describeAgent, gateApi, type SessionRow, type TotpSetup } from "../../settings/gate.ts";

/** What the gate said, as a sentence for the form. */
function refusal(err: unknown): string {
  if (err instanceof HttpError && typeof err.body.message === "string") return err.body.message;
  return errorText(err);
}

function PasswordForm({ twoFactor }: { twoFactor: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!current || !next) return setError("Fill in your current password and the new one.");
    if (next !== again) return setError("The new password and its repeat do not match.");
    if (twoFactor && !code.trim()) return setError("Enter the code from your authenticator app.");
    setBusy(true);
    try {
      const res = await gateApi.changePassword({ password: current, ...(twoFactor ? { code: code.trim() } : {}) }, next);
      setCurrent("");
      setNext("");
      setAgain("");
      setCode("");
      toast(
        "success",
        "Password changed.",
        res.endedSessions ? `${res.endedSessions} other session${res.endedSessions === 1 ? " was" : "s were"} signed out.` : undefined,
      );
    } catch (err) {
      setError(refusal(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-form" onSubmit={(e) => void submit(e)}>
      <label className="field">
        <span className="field-label">Current password</span>
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <div className="field-row">
        <label className="field">
          <span className="field-label">New password</span>
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Repeat it</span>
          <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </label>
      </div>
      {twoFactor && (
        <label className="field">
          <span className="field-label">Two-factor code</span>
          <input className="input mono" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="settings-actions">
        <span className="field-hint">Changing it signs out every other session.</span>
        <button className="btn btn-small btn-primary" type="submit" disabled={busy}>
          Change password
        </button>
      </div>
    </form>
  );
}

type Enrol = { step: "setup"; password: string; setup: TotpSetup } | { step: "codes"; codes: string[] };

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone(): void }) {
  const [copied, setCopied] = useState(false);
  const text = `agentbox recovery codes for ${location.host}\nEach works once, in place of a 6-digit code.\n\n${codes.join("\n")}\n`;
  return (
    <Dialog title="Save your recovery codes" onClose={onDone} onSubmit={onDone} submitLabel="I have saved them" cancelLabel="Close">
      <p className="dialog-text">
        Two-factor is on. If you lose your authenticator, each of these signs you in once. Keep them somewhere safe — they are shown only now.
      </p>
      <ol className="recovery-codes mono">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="settings-actions is-start">
        <button
          className="btn btn-small"
          onClick={() =>
            void navigator.clipboard.writeText(codes.join("\n")).then(
              () => setCopied(true),
              () => toast("error", "Couldn't copy to the clipboard."),
            )
          }
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
        <a
          className="btn btn-small"
          download="agentbox-recovery-codes.txt"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}
        >
          <Download size={14} aria-hidden="true" />
          Download
        </a>
      </div>
    </Dialog>
  );
}

function EnrolDialog({ enrol, onCodes, onClose }: { enrol: Extract<Enrol, { step: "setup" }>; onCodes(codes: string[]): void; onClose(): void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmCode = async () => {
    if (!/^\d{6}$/.test(code.trim())) return setError("Enter the 6-digit code your authenticator shows.");
    setBusy(true);
    try {
      const { recoveryCodes } = await gateApi.totpConfirm(enrol.password, code.trim());
      onCodes(recoveryCodes);
    } catch (err) {
      setError(refusal(err));
    } finally {
      setBusy(false);
    }
  };
  const qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(enrol.setup.qrSvg)}`;
  return (
    <Dialog title="Turn on two-factor" onClose={onClose} onSubmit={() => void confirmCode()} submitLabel="Turn on" submitDisabled={busy}>
      <div className="totp-setup">
        <img className="totp-qr" src={qr} alt="QR code for your authenticator app" width={176} height={176} />
        <div className="totp-steps">
          <p className="dialog-text">Scan this with an authenticator app (1Password, Google Authenticator, Aegis…), then enter the code it shows.</p>
          <p className="field-hint">Or type this key in by hand:</p>
          <code className="totp-secret">{enrol.setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
          <label className="field">
            <span className="field-label">Code from the app</span>
            <input
              className="input mono"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              data-autofocus
              value={code}
              onChange={(e) => {
                setCode(e.target.value.replace(/\D/g, ""));
                setError(null);
              }}
            />
          </label>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function TwoFactor({ on, refresh }: { on: boolean; refresh(): void }) {
  const [asking, setAsking] = useState<null | "enable" | "disable">(null);
  const [enrol, setEnrol] = useState<Enrol | null>(null);

  return (
    <div className="settings-card">
      <div className="settings-row">
        <span className={`settings-glyph${on ? " is-on" : ""}`} aria-hidden="true">
          <ShieldCheck size={16} />
        </span>
        <div className="settings-row-text">
          <strong>Two-factor sign-in {on ? "is on" : "is off"}</strong>
          <span>{on ? "Signing in asks for a code from your authenticator app, or a recovery code." : "Add a 6-digit code from an authenticator app to every sign-in. Recommended."}</span>
        </div>
        {on ? (
          <button className="btn btn-small btn-ghost is-danger" onClick={() => setAsking("disable")}>
            Turn off
          </button>
        ) : (
          <button className="btn btn-small btn-primary" onClick={() => setAsking("enable")}>
            Turn on
          </button>
        )}
      </div>
      {asking === "enable" && (
        <CredentialsDialog
          title="Turn on two-factor"
          body="Confirm it is you first."
          confirmLabel="Continue"
          twoFactor={false}
          onClose={() => setAsking(null)}
          onSubmit={async (c) => {
            try {
              const setup = await gateApi.totpSetup(c);
              setAsking(null);
              setEnrol({ step: "setup", password: c.password, setup });
              return null;
            } catch (err) {
              return refusal(err);
            }
          }}
        />
      )}
      {asking === "disable" && (
        <CredentialsDialog
          title="Turn off two-factor?"
          body="Signing in will ask only for your password. Every other session is signed out."
          confirmLabel="Turn off"
          danger
          twoFactor
          onClose={() => setAsking(null)}
          onSubmit={async (c) => {
            try {
              await gateApi.totpDisable(c);
              setAsking(null);
              toast("info", "Two-factor is off.");
              refresh();
              return null;
            } catch (err) {
              return refusal(err);
            }
          }}
        />
      )}
      {enrol?.step === "setup" && (
        <EnrolDialog
          enrol={enrol}
          onClose={() => setEnrol(null)}
          onCodes={(codes) => {
            setEnrol({ step: "codes", codes });
            refresh();
          }}
        />
      )}
      {enrol?.step === "codes" && (
        <RecoveryCodes
          codes={enrol.codes}
          onDone={() => {
            setEnrol(null);
            toast("success", "Two-factor is on.", "Other sessions were signed out.");
          }}
        />
      )}
    </div>
  );
}

function Sessions() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const load = useCallback(async () => setRows(await gateApi.sessions()), []);
  usePolling(load, 30_000);

  const end = async (s: SessionRow) => {
    if (s.current) {
      if (await confirm({ title: "Sign out here?", body: "This browser goes back to the sign-in page.", confirmLabel: "Sign out" })) await signOut();
      return;
    }
    try {
      await gateApi.endSession(s.id);
      void load();
    } catch (err) {
      toastError("Couldn't end that session.", err);
    }
  };

  const endOthers = async () => {
    if (!(await confirm({ title: "Sign out everywhere else?", body: "Every other browser signed in to this box goes back to the sign-in page.", confirmLabel: "Sign out others" }))) return;
    try {
      const { ended } = await gateApi.endOthers();
      toast("success", ended === 1 ? "Signed out 1 other session." : `Signed out ${ended} other sessions.`);
      void load();
    } catch (err) {
      toastError("Couldn't sign the others out.", err);
    }
  };

  const others = (rows ?? []).filter((r) => !r.current).length;

  return (
    <Section
      title="Sessions"
      count={rows?.length}
      id="sessions"
      action={
        others > 0 ? (
          <button className="btn btn-small btn-ghost" onClick={() => void endOthers()}>
            Sign out everywhere else
          </button>
        ) : undefined
      }
    >
      <ul className="settings-list">
        {(rows ?? []).map((s) => (
          <li key={s.id} className="settings-row">
            <div className="settings-row-text">
              <strong>
                {describeAgent(s.userAgent)}
                {s.current && <span className="pill is-current">This browser</span>}
              </strong>
              <span>
                {s.ip} · signed in {formatAgo(s.createdAt)} · last seen {formatAgo(s.lastSeenAt)}
                {s.remember ? " · remembered" : ""}
              </span>
            </div>
            <button className="btn btn-small btn-ghost" onClick={() => void end(s)}>
              {s.current ? "Sign out" : "End"}
            </button>
          </li>
        ))}
        {rows === null && <li className="skeleton" style={{ height: 56 }} aria-hidden="true" />}
      </ul>
    </Section>
  );
}

/** Settings → Account: who you are, the password, two-factor and where you are signed in. */
export function AccountSection() {
  const session = useGateSession((s) => s.session);
  const refresh = () => void useGateSession.getState().refresh();
  const twoFactor = session?.twoFactor === true;

  return (
    <>
      <Section title="Signed in" id="whoami">
        <div className="settings-card">
          <div className="settings-row">
            <span className="settings-glyph" aria-hidden="true">
              <KeyRound size={16} />
            </span>
            <div className="settings-row-text">
              <strong>{session?.user ?? "…"}</strong>
              <span>
                {location.host}
                {session?.expiresAt ? ` · this session ends ${session.remember ? "on" : "after 12 hours idle, by"} ${new Date(session.expiresAt).toLocaleString()}` : ""}
              </span>
            </div>
            <button className="btn btn-small" onClick={() => void signOut()}>
              <LogOut size={14} aria-hidden="true" />
              Sign out
            </button>
          </div>
        </div>
      </Section>
      <Section title="Password" id="password">
        <div className="settings-card">
          <PasswordForm twoFactor={twoFactor} />
        </div>
      </Section>
      <Section title="Two-factor" id="twofactor">
        <TwoFactor on={twoFactor} refresh={refresh} />
      </Section>
      <Sessions />
    </>
  );
}
