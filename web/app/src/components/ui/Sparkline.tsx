import { useId, useState } from "react";

interface Props {
  /** Oldest first. Nulls are gaps. */
  values: (number | null)[];
  /** The top of the scale; the line is drawn against 0..max. */
  max: number;
  /** Words for a value, for the hover label and the summary. */
  format(v: number): string;
  label: string;
  /** Seconds between readings, to say how long the line covers. */
  step: number;
}

const W = 240;
const H = 40;

/**
 * A trend line for a stat tile: the recent readings in the de-emphasis ink,
 * the current one a dot in the accent. Hover (or touch) shows the reading
 * under the pointer; the summary is its accessible name.
 */
export function Sparkline({ values, max, format, label, step }: Props) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;
  if (n < 2) return <div className="spark is-empty" aria-hidden="true" />;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => H - 2 - (Math.min(v, max) / (max || 1)) * (H - 4);
  let d = "";
  values.forEach((v, i) => {
    if (v === null) return;
    d += `${d && values[i - 1] !== null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  const lastIndex = n - 1;
  const last = values[lastIndex];
  const firstKnown = values.find((v) => v !== null);
  const span = Math.round(((n - 1) * step) / 60);
  const summary = `${label}, the last ${span < 1 ? "minute" : `${span} minutes`}: from ${firstKnown != null ? format(firstKnown) : "—"} to ${last != null ? format(last) : "—"}`;
  const shown = hover !== null ? values[hover] : null;

  return (
    <div className="spark">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-labelledby={id}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(lastIndex, Math.round(((e.clientX - r.left) / r.width) * lastIndex))));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <title id={id}>{summary}</title>
        <path className="spark-area" d={`${d}L${W},${H}L0,${H}Z`} />
        <path className="spark-line" d={d} vectorEffect="non-scaling-stroke" />
        {hover !== null && <line className="spark-cross" x1={x(hover)} x2={x(hover)} y1={0} y2={H} vectorEffect="non-scaling-stroke" />}
      </svg>
      {last != null && <span className="spark-dot" style={{ left: "100%", top: `${(y(last) / H) * 100}%` }} aria-hidden="true" />}
      {hover !== null && shown != null && (
        <span className="spark-tip" style={{ left: `${(hover / lastIndex) * 100}%` }} aria-hidden="true">
          {format(shown)} · {Math.round(((lastIndex - hover) * step))} s ago
        </span>
      )}
    </div>
  );
}
