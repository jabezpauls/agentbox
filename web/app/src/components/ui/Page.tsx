import type { ReactNode } from "react";

interface Props {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** A row under the title: tabs, filters. */
  children?: ReactNode;
  /** The id the surface's heading takes, for aria-labelledby. */
  id?: string;
}

/**
 * A surface's header: the one page-title size (18px at
 * weight 500), a muted line under it, and the actions on the right.
 */
export function PageHeader({ title, subtitle, actions, children, id }: Props) {
  return (
    <header className="page-head">
      <div className="page-head-row">
        <div className="page-head-text">
          <h1 className="page-title" id={id} tabIndex={-1}>
            {title}
          </h1>
          {subtitle && <p className="page-sub">{subtitle}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/** A section of a page: the micro-label, an optional count and action, then the content. */
export function Section({
  title,
  count,
  action,
  children,
  id,
}: {
  title: string;
  count?: number | string | undefined;
  action?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className="page-section" aria-labelledby={headingId}>
      <div className="section-head">
        <h2 className="section-label" id={headingId}>
          {title}
          {count !== undefined && <span className="section-count"> · {count}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A calm empty state: a soft circle, a short truth, one concrete line, maybe one action. */
export function Empty({
  icon,
  title,
  sub,
  action,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  sub?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty${compact ? " is-compact" : ""}`}>
      {icon && (
        <span className="empty-glyph" aria-hidden="true">
          {icon}
        </span>
      )}
      <p className="empty-title">{title}</p>
      {sub && <p className="empty-sub">{sub}</p>}
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}
