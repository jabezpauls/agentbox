import { useCallback, useState } from "react";
import { Check, Copy, Laptop, TerminalSquare } from "lucide-react";
import { errorText, HttpError } from "../../api/http.ts";
import { formatAgo } from "../../lib/format.ts";
import { Empty, Section } from "../../components/ui/Page.tsx";
import { usePolling, useWhenHidden } from "../../shell/activity.tsx";
import { useGateSession } from "../../shell/session.ts";
import { toast } from "../../shell/toast.ts";
import { CredentialsDialog } from "../../settings/CredentialsDialog.tsx";
import { gateApi, type TokenRow } from "../../settings/gate.ts";

/** A device code as the CLI prints it: XXXX-XXXX. */
export function normaliseCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
}

function CopyLine({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-line">
      <code className="copy-line-text">{text}</code>
      <button
        className="btn btn-small"
        aria-label={label}
        onClick={() =>
          void navigator.clipboard.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            },
            () => toast("error", "Couldn't copy to the clipboard."),
          )
        }
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * Settings → Devices & CLI: install the `agentbox` command on a laptop,
 * approve its sign-in, and see and revoke the devices that have a token.
 * Approval happens on the gate's own page (`/settings/devices?code=`),
 * outside the sandbox, which is where what decides who gets in belongs.
 */
export function DevicesSection() {
  const twoFactor = useGateSession((s) => s.session?.twoFactor === true);
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<TokenRow | null>(null);
  useWhenHidden(() => setRevoking(null));

  const load = useCallback(async () => {
    try {
      setTokens(await gateApi.tokens());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  usePolling(load, 15_000);

  const approve = (e: React.FormEvent) => {
    e.preventDefault();
    const c = normaliseCode(code);
    if (!c) return setCodeError("A code is eight letters and digits, like ABCD-1234.");
    // The gate's own page, a full navigation: it asks for the password there.
    window.location.assign(`/settings/devices?code=${encodeURIComponent(c)}`);
  };

  return (
    <>
      <Section title="The agentbox command" id="cli">
        <div className="settings-card">
          <div className="settings-row is-top">
            <span className="settings-glyph" aria-hidden="true">
              <TerminalSquare size={16} />
            </span>
            <div className="settings-row-text">
              <strong>Use this box from your laptop</strong>
              <span>
                Installs <code>agentbox</code> (Node 20 or later) and signs it in through this browser. Then <code>agentbox attach</code>,{" "}
                <code>agentbox forward 5173</code>, <code>agentbox mount</code> and <code>agentbox files put</code> work from your own terminal.
              </span>
            </div>
          </div>
          <CopyLine text={`curl -fsSL ${location.origin}/cli/install | sh`} label="Copy the install command" />
        </div>
      </Section>

      <Section title="Approve a sign-in" id="approve">
        <form className="settings-card settings-form is-inline" onSubmit={approve}>
          <label className="field">
            <span className="field-label">Code the CLI shows</span>
            <input
              className="input mono"
              placeholder="ABCD-1234"
              autoCapitalize="characters"
              spellCheck={false}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setCodeError(null);
              }}
            />
          </label>
          <button className="btn btn-small btn-primary" type="submit">
            Continue
          </button>
          {codeError && (
            <p className="field-error" role="alert">
              {codeError}
            </p>
          )}
          <p className="field-hint">
            <code>agentbox login</code> opens this for you. Approving gives that device full access to the box.
          </p>
        </form>
      </Section>

      <Section title="Devices" count={tokens?.length} id="devices">
        {error ? (
          <Empty compact title="Couldn't read the devices." sub={error} />
        ) : tokens && tokens.length === 0 ? (
          <Empty compact icon={<Laptop size={22} />} title="No devices yet." sub="A laptop you sign in with the agentbox command appears here, and can be revoked." />
        ) : (
          <ul className="settings-list">
            {(tokens ?? []).map((t) => (
              <li key={t.id} className="settings-row">
                <span className="settings-glyph" aria-hidden="true">
                  <Laptop size={16} />
                </span>
                <div className="settings-row-text">
                  <strong>{t.name}</strong>
                  <span>
                    Added {formatAgo(t.createdAt)} · {t.lastUsedAt ? `last used ${formatAgo(t.lastUsedAt)}${t.lastIp ? ` from ${t.lastIp}` : ""}` : "never used"}
                  </span>
                </div>
                <button className="btn btn-small btn-ghost is-danger" onClick={() => setRevoking(t)}>
                  Revoke
                </button>
              </li>
            ))}
            {tokens === null && <li className="skeleton" style={{ height: 56 }} aria-hidden="true" />}
          </ul>
        )}
      </Section>

      {revoking && (
        <CredentialsDialog
          title={`Revoke ${revoking.name}?`}
          body="That device loses access at once. Signing it in again needs a new approval."
          confirmLabel="Revoke"
          danger
          twoFactor={twoFactor}
          onClose={() => setRevoking(null)}
          onSubmit={async (c) => {
            try {
              await gateApi.revokeToken(revoking.id, c);
              toast("success", `Revoked ${revoking.name}.`);
              setRevoking(null);
              void load();
              return null;
            } catch (err) {
              return err instanceof HttpError && typeof err.body.message === "string" ? err.body.message : errorText(err);
            }
          }}
        />
      )}
    </>
  );
}
