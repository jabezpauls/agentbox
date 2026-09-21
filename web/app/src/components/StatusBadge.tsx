import type { AgentStatus } from "@workbench/shared";

const LABELS: Record<AgentStatus, string> = {
  blocked: "Blocked",
  working: "Working",
  done: "Done",
  idle: "Idle",
  unknown: "Idle",
};

export const STATUS_LABELS = LABELS;

interface Props {
  status: AgentStatus;
  /** `dot` is a bare status light; `badge` adds a text label. */
  variant?: "dot" | "badge";
  /** Override the default label (badge only). */
  label?: string;
  /** Dim the dot when a workspace/tab hosts no agents at all. */
  muted?: boolean;
  title?: string;
}

/**
 * The single source of the status vocabulary. A dot for rollups, a soft-tinted
 * pill for anywhere a word fits. `working` gets a slow, subtle pulse
 * (respecting reduced-motion) so an active agent reads as alive without
 * shouting.
 *
 * Colour never carries the meaning alone: the pill states it in words, and the
 * bare dot carries the same word as its accessible name and its tooltip.
 */
export function StatusBadge({ status, variant = "dot", label, muted, title }: Props) {
  const cls = [
    variant === "dot" ? "status-dot" : "pill status-badge",
    `is-${status}`,
    status === "working" ? "is-live" : "",
    muted ? "is-muted" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (variant === "dot") {
    return <span className={cls} role="img" aria-label={label ?? LABELS[status]} title={title ?? LABELS[status]} />;
  }
  return (
    <span className={cls} title={title}>
      <span className="pill-dot" aria-hidden="true" />
      {label ?? LABELS[status]}
    </span>
  );
}
