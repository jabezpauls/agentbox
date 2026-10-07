import { useEffect, useState } from "react";
import { AlertTriangle, OctagonPause } from "lucide-react";
import type { ProviderUsage, UsageWindow } from "@workbench/shared";
import { useApp } from "../store/app.ts";
import { usePageVisible } from "../shell/activity.tsx";
import {
  formatAgoShort,
  formatCountdown,
  limitedWindow,
  providerName,
  resetClock,
  severityClass,
  shownProviders,
  soonestEta,
  spokenCountdown,
  untilReset,
  windowLong,
  WINDOWS,
  type WindowKey,
} from "../usage/model.ts";

/**
 * The clock the countdowns run on, in epoch seconds. It ticks every second
 * while the page is in view — a countdown under a minute counts seconds — and
 * stops when nobody can see it.
 */
export function useNowSeconds(): number {
  const visible = usePageVisible();
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now() / 1000);
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [visible]);
  return now;
}

const clamp = (n: number) => Math.min(100, Math.max(0, n));
// A window can't end past its cap: the bridge projects at most 100%, and a
// figure from anywhere else is held to it too.
const pct = (n: number) => `${Math.round(clamp(n))}%`;

interface RowProps {
  provider: string;
  win: WindowKey;
  w: UsageWindow;
  now: number;
  large: boolean;
  capped: boolean;
}

/** One window: a bar of what is used, a ghost of where it is headed, and when it resets. */
function WindowRow({ provider, win, w, now, large, capped }: RowProps) {
  const meta = WINDOWS.find((x) => x.key === win)!;
  const left = untilReset(w, now);
  const clock = resetClock(w.resetsAt, now);
  const severity = capped ? "hot" : w.severity;
  // A capped window is going nowhere until it resets: no pace to show.
  const pace = w.projectedPct === null || capped ? null : `→${pct(w.projectedPct)}`;
  const spoken = [
    `${pct(w.usedPct)} used`,
    w.projectedPct !== null ? `on pace for ${pct(w.projectedPct)} by the reset` : null,
    `resets in ${spokenCountdown(left)}, at ${clock}`,
  ]
    .filter(Boolean)
    .join(", ");
  const title = [
    `${provider}, ${meta.long} window: ${pct(w.usedPct)} used`,
    w.projectedPct !== null ? `on pace for ${pct(w.projectedPct)}` : null,
    `resets ${clock} (in ${formatCountdown(left)})`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={`usage-row ${severityClass(severity)}`}
      role="meter"
      aria-label={`${provider} ${meta.long} window`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamp(w.usedPct))}
      aria-valuetext={spoken}
      title={title}
    >
      <span className="usage-win">{large ? (win === "fiveHour" ? "5-hour" : "Weekly") : meta.short}</span>
      <span className="usage-track">
        {w.projectedPct !== null && <span className="usage-ghost" style={{ width: `${clamp(w.projectedPct)}%` }} />}
        <span className="usage-fill" style={{ width: `${clamp(w.usedPct)}%` }} />
      </span>
      <span className="usage-pct">{pct(w.usedPct)}</span>
      <span className="usage-pace">{pace}</span>
      <span className="usage-reset">{large ? `${formatCountdown(left)} · ${clock}` : formatCountdown(left)}</span>
    </div>
  );
}

function ProviderBlock({ p, computedAt, now, large }: { p: ProviderUsage; computedAt: number; now: number; large: boolean }) {
  const name = providerName(p.provider);
  const capped = limitedWindow(p);
  const cappedWindow = capped ? p[capped] : null;
  const eta = capped ? null : soonestEta(p, computedAt, now);
  const ago = p.stale && p.observedAt !== null ? formatAgoShort(now - p.observedAt) : null;

  return (
    <div className={`usage-provider${p.stale ? " is-stale" : ""}${capped ? " is-limited" : ""}`}>
      <div className="usage-head">
        <span className="usage-name">{name}</span>
        {ago && (
          <span className="usage-asof" title="No live session has refreshed these numbers since.">
            as of {ago}
          </span>
        )}
        {eta && (
          <span
            className="usage-eta"
            role="img"
            aria-label={`${windowLong(eta.key)} limit in about ${spokenCountdown(eta.seconds)} at this pace`}
            title={`At this pace, the ${windowLong(eta.key)} limit is reached in about ${formatCountdown(eta.seconds)}.`}
          >
            <AlertTriangle size={11} aria-hidden="true" />
            {large && `${windowLong(eta.key)} limit in `}~{formatCountdown(eta.seconds)}
          </span>
        )}
      </div>
      {capped && cappedWindow && (
        <div className="usage-limit" role="status" title={`Agents on ${name} wait until ${resetClock(cappedWindow.resetsAt, now)}.`}>
          <OctagonPause size={13} aria-hidden="true" />
          <span>
            {large ? `${windowLong(capped)[0]!.toUpperCase()}${windowLong(capped).slice(1)} limit reached` : "Limit reached"} · resets in{" "}
            <span className="usage-num">{formatCountdown(untilReset(cappedWindow, now))}</span>
          </span>
        </div>
      )}
      <div className="usage-rows">
        {WINDOWS.map(({ key }) => {
          const w = p[key];
          return w ? <WindowRow key={key} provider={name} win={key} w={w} now={now} large={large} capped={capped === key} /> : null;
        })}
      </div>
    </div>
  );
}

interface Props {
  /** `compact` for the sidebar's foot; `large` for Home. */
  variant?: "compact" | "large";
  className?: string;
}

/**
 * Plan usage, per provider that has reported: the 5-hour and 7-day windows as
 * the terminal's status bar shows them — used, where it is headed, when it
 * resets — with a warning when the cap is under the hour, a clear state when
 * it is reached, and a faded one when the numbers are old. Nothing at all
 * until an agent has said something.
 */
export function UsageMeters({ variant = "compact", className }: Props) {
  const usage = useApp((s) => s.usage);
  const now = useNowSeconds();
  const providers = shownProviders(usage);
  if (!usage || providers.length === 0) return null;
  const large = variant === "large";
  return (
    <div className={`usage is-${variant}${className ? ` ${className}` : ""}`} role="group" aria-label="Plan usage">
      {providers.map((p) => (
        <ProviderBlock key={p.provider} p={p} computedAt={usage.computedAt} now={now} large={large} />
      ))}
    </div>
  );
}
