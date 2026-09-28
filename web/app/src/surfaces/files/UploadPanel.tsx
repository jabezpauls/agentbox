import { ChevronDown, ChevronUp, RotateCw, X } from "lucide-react";
import { formatBytes, plural } from "../../lib/format.ts";
import { summarise, type UploadItem } from "../../files/upload-queue.ts";
import { uploads, useUploads } from "../../files/uploads.ts";
import { basename, dirname } from "../../files/paths.ts";

const STATE_TEXT: Partial<Record<UploadItem["state"], string>> = {
  queued: "Waiting",
  finishing: "Finishing",
  done: "Uploaded",
  cancelled: "Cancelled",
  skipped: "Skipped",
  conflict: "Already there",
};

function Row({ item }: { item: UploadItem }) {
  const pct = item.size === 0 ? 100 : Math.round((item.sent / item.size) * 100);
  const live = item.state === "uploading" || item.state === "queued" || item.state === "finishing";
  const text =
    item.state === "uploading"
      ? item.error ?? `${formatBytes(item.sent)} of ${formatBytes(item.size)}`
      : item.state === "error"
        ? item.error ?? "Failed"
        : STATE_TEXT[item.state];
  return (
    <li className={`up-row is-${item.state}`}>
      <div className="up-row-text">
        <span className="up-name" title={item.dest}>
          {item.name}
        </span>
        <span className="up-state">
          {text}
          {item.state === "conflict" ? ` in ${basename(dirname(item.dest))}` : ""}
        </span>
      </div>
      {live && (
        <div className="progress" role="progressbar" aria-label={`Uploading ${item.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
      {item.state === "conflict" && (
        <span className="up-choices">
          <button className="btn btn-small btn-ghost" onClick={() => uploads.resolve(item.id, "replace")}>
            Replace
          </button>
          <button className="btn btn-small btn-ghost" onClick={() => uploads.resolve(item.id, "rename")}>
            Keep both
          </button>
          <button className="btn btn-small btn-ghost" onClick={() => uploads.resolve(item.id, "skip")}>
            Skip
          </button>
        </span>
      )}
      {item.state === "error" && (
        <button className="icon-btn is-sm" aria-label={`Retry ${item.name}`} title="Retry" onClick={() => uploads.retry(item.id)}>
          <RotateCw size={13} />
        </button>
      )}
      {live && (
        <button className="icon-btn is-sm" aria-label={`Cancel ${item.name}`} title="Cancel" onClick={() => uploads.cancel(item.id)}>
          <X size={13} />
        </button>
      )}
    </li>
  );
}

/**
 * Uploads in progress, in a card at the bottom right that stays while you
 * move around the app — uploads keep going. It says how much is left,
 * lets you stop one file or all of them, and asks, once, what to do with
 * names that are already taken.
 */
export function UploadPanel() {
  const items = useUploads((s) => s.items);
  const collapsed = useUploads((s) => s.collapsed);
  if (items.length === 0) return null;

  const s = summarise(items);
  const busy = s.active > 0;
  const pct = s.bytes === 0 ? (busy ? 0 : 100) : Math.round((s.sent / s.bytes) * 100);
  const title = s.conflicts
    ? `${plural(s.conflicts, "file")} already there`
    : busy
      ? `Uploading ${plural(s.files, "file")}`
      : s.errors
        ? `${plural(s.errors, "upload")} failed`
        : `Uploaded ${plural(s.done, "file")}`;
  const sub = busy ? `${formatBytes(Math.max(0, s.bytes - s.sent))} left · ${s.done} of ${s.files} done` : s.errors ? "Retry, or dismiss." : "Done.";
  const shown = [...items].reverse().slice(0, 200);

  return (
    <section className={`uploads${collapsed ? " is-collapsed" : ""}`} aria-label="Uploads" aria-live="polite">
      <header className="uploads-head">
        <div className="uploads-title">
          <strong>{title}</strong>
          <span>{sub}</span>
        </div>
        {busy && (
          <button className="btn btn-small btn-ghost" onClick={() => uploads.cancelAll()}>
            Cancel all
          </button>
        )}
        <button
          className="icon-btn"
          aria-label={collapsed ? "Show uploads" : "Fold uploads"}
          aria-expanded={!collapsed}
          onClick={() => useUploads.setState({ collapsed: !collapsed })}
        >
          {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
        {!busy && s.conflicts === 0 && (
          <button className="icon-btn" aria-label="Dismiss uploads" onClick={() => uploads.clearFinished()}>
            <X size={15} />
          </button>
        )}
      </header>
      <div className="progress uploads-total" role="progressbar" aria-label="All uploads" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      {!collapsed && (
        <>
          {s.conflicts > 1 && (
            <div className="uploads-conflicts">
              <span>For all {s.conflicts}:</span>
              <button className="btn btn-small" onClick={() => uploads.resolveAll("replace")}>
                Replace
              </button>
              <button className="btn btn-small" onClick={() => uploads.resolveAll("rename")}>
                Keep both
              </button>
              <button className="btn btn-small btn-ghost" onClick={() => uploads.resolveAll("skip")}>
                Skip
              </button>
            </div>
          )}
          <ul className="uploads-list">
            {shown.map((i) => (
              <Row key={i.id} item={i} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
