import { loadOf } from "../../system/model.ts";

interface Props {
  label: string;
  /** 0–1; null when it cannot be told. */
  fraction: number | null;
  /** The reading in words: "2.4 of 8 cores". */
  value: string;
  /** A second line: what the limit is, or where the number comes from. */
  sub?: string | undefined;
  compact?: boolean;
}

const LOAD_WORD = { ok: "", warn: "Getting full", high: "Nearly full" } as const;

/**
 * A ratio against a limit. The fill carries the load — accent, then warning,
 * then danger — over a track that is a lighter step of the same colour, and
 * the percentage and the reading are always there in words, so colour never
 * carries the meaning on its own.
 */
export function Meter({ label, fraction, value, sub, compact }: Props) {
  const load = loadOf(fraction);
  const pct = fraction === null ? null : Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div className={`meter is-${load}${compact ? " is-compact" : ""}`}>
      <div className="meter-top">
        <span className="meter-label">{label}</span>
        <span className="meter-pct">{pct === null ? "—" : `${pct}%`}</span>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={`${value}${LOAD_WORD[load] ? `, ${LOAD_WORD[load].toLowerCase()}` : ""}`}
      >
        <span className="meter-fill" style={{ width: `${pct ?? 0}%` }} />
      </div>
      <div className="meter-value">
        {value}
        {LOAD_WORD[load] && <span className="meter-warn"> · {LOAD_WORD[load]}</span>}
      </div>
      {sub && <div className="meter-sub">{sub}</div>}
    </div>
  );
}
