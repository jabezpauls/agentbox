import { useState } from "react";
import { Globe } from "lucide-react";
import { appsApi, isPublic, useApps } from "../../apps/model.ts";
import { VisibilityBadge } from "../../apps/badges.tsx";
import { defaultExpiry, EXPIRIES, setDefaultExpiry } from "../../apps/share.ts";
import { Empty, Section } from "../../components/ui/Page.tsx";
import { confirm } from "../../components/ui/prompts.tsx";
import { usePolling } from "../../shell/activity.tsx";
import { navigate } from "../../shell/router.ts";
import { toast, toastError } from "../../shell/toast.ts";

/**
 * Settings → Sharing: how long a new share lasts unless you say otherwise,
 * and every app that is public right now, in one place, each one click from
 * private again.
 */
export function SharingSection() {
  const apps = useApps((s) => s.apps);
  const [expiry, setExpiry] = useState(() => defaultExpiry().id);
  usePolling(() => useApps.getState().refresh(), 10_000);

  const shared = (apps ?? []).filter((a) => isPublic(a));

  const stop = async (id: string, name: string) => {
    if (!(await confirm({ title: `Stop sharing ${name}?`, body: "The link stops working at once, and anyone still viewing is cut off.", confirmLabel: "Stop sharing" }))) return;
    try {
      await appsApi.unshare(id);
      toast("success", `${name} is private again.`);
      void useApps.getState().refresh();
    } catch (err) {
      toastError(`Couldn't stop sharing ${name}.`, err);
    }
  };

  return (
    <>
      <Section title="New shares last" id="expiry">
        <div className="settings-card">
          <div className="segmented is-wrap" role="radiogroup" aria-label="How long a new share lasts">
            {EXPIRIES.map((e) => (
              <button
                key={e.id}
                role="radio"
                aria-checked={expiry === e.id}
                className={`segmented-btn${expiry === e.id ? " is-active" : ""}`}
                onClick={() => {
                  setExpiry(e.id);
                  setDefaultExpiry(e.id);
                }}
              >
                {e.label}
              </button>
            ))}
          </div>
          <p className="field-hint">What Share starts with. You can pick another each time.</p>
        </div>
      </Section>
      <Section title="Shared now" count={shared.length} id="shared">
        {shared.length === 0 ? (
          <Empty compact icon={<Globe size={22} />} title="Nothing is shared." sub="Every app is private: only you, signed in, can open it." />
        ) : (
          <ul className="settings-list">
            {shared.map((a) => (
              <li key={a.id} className="settings-row">
                <div className="settings-row-text">
                  <strong>
                    <button className="linklike" onClick={() => navigate({ surface: "apps", appId: a.id })}>
                      {a.name}
                    </button>
                  </strong>
                  <span className="mono">{`${location.origin}${a.url}`}</span>
                </div>
                <VisibilityBadge app={a} />
                <button className="btn btn-small btn-ghost is-danger" onClick={() => void stop(a.id, a.name)}>
                  Stop sharing
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
