import { useMemo, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import type { TrashItem } from "@workbench/shared";
import { formatAgo, formatBytes, plural } from "../../lib/format.ts";
import { dirname } from "../../files/paths.ts";
import { Empty } from "../../components/ui/Page.tsx";
import { deleteForever, emptyTrash, restoreFromTrash } from "./actions.ts";
import { iconFor } from "./icons.tsx";

interface Props {
  items: TrashItem[] | null;
  error: string | null;
  onChange(): void;
  /** Show where a thing came from. */
  onReveal(dir: string): void;
}

/**
 * The trash: everything deleted from Files, the editor's explorer or a
 * WebDAV mount, newest first, with where it came from. Restore puts it back
 * there; only here is anything deleted for good.
 */
export function TrashView({ items, error, onChange, onReveal }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const list = useMemo(() => items ?? [], [items]);
  const chosen = list.filter((i) => selected.has(i.id));

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const done = () => {
    setSelected(new Set());
    onChange();
  };

  if (items === null && !error) {
    return (
      <div className="trash is-loading" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ height: 36, margin: "4px 16px" }} />
        ))}
      </div>
    );
  }

  return (
    <div className="trash">
      <div className="trash-bar">
        <p className="trash-note">
          {list.length === 0
            ? "The trash is empty."
            : `${plural(list.length, "item")}. Restoring puts each back where it was.`}
        </p>
        <div className="trash-actions">
          {chosen.length > 0 && (
            <>
              <button className="btn btn-small" onClick={() => void restoreFromTrash(chosen.map((c) => c.id), done)}>
                <RotateCcw size={14} aria-hidden="true" />
                Restore {chosen.length > 1 ? chosen.length : ""}
              </button>
              <button
                className="btn btn-small btn-ghost is-danger"
                onClick={() => void deleteForever(chosen.map((c) => c.id), chosen[0]!.name, done)}
              >
                Delete for good
              </button>
            </>
          )}
          {list.length > 0 && chosen.length === 0 && (
            <button className="btn btn-small btn-ghost is-danger" onClick={() => void emptyTrash(list.length, done)}>
              <Trash2 size={14} aria-hidden="true" />
              Empty trash
            </button>
          )}
        </div>
      </div>
      {error ? (
        <Empty title="Couldn't read the trash." sub={error} action={<button className="btn btn-small" onClick={onChange}>Retry</button>} />
      ) : list.length === 0 ? (
        <Empty icon={<Trash2 size={22} />} title="Nothing in the trash." sub="Things you delete in Files land here first, and can be put back." />
      ) : (
        <table className="trash-table">
          <thead>
            <tr>
              <th className="c-check" aria-label="Selected" />
              <th>Name</th>
              <th className="c-from">Was in</th>
              <th className="c-when">Deleted</th>
              <th className="c-size">Size</th>
              <th className="c-act" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {list.map((item) => {
              const Icon = iconFor({ name: item.name, path: item.originalPath, type: item.type, size: item.size ?? 0, mtime: item.trashedAt });
              const from = dirname(item.originalPath);
              return (
                <tr key={item.id} className={selected.has(item.id) ? "is-selected" : undefined} onClick={() => toggle(item.id)}>
                  <td className="c-check">
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      aria-label={`Select ${item.name}`}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggle(item.id)}
                    />
                  </td>
                  <td className="c-name">
                    <span className="frow-icon" aria-hidden="true">
                      <Icon size={16} strokeWidth={1.75} />
                    </span>
                    <span className="frow-name">{item.name}</span>
                  </td>
                  <td className="c-from">
                    <button
                      className="linklike trash-from"
                      title={`Show ${from}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onReveal(from);
                      }}
                    >
                      {from}
                    </button>
                  </td>
                  <td className="c-when" title={new Date(item.trashedAt).toLocaleString()}>
                    {formatAgo(item.trashedAt)}
                  </td>
                  <td className="c-size">{item.size === null ? "—" : formatBytes(item.size)}</td>
                  <td className="c-act">
                    <button
                      className="btn btn-small btn-ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        void restoreFromTrash([item.id], done);
                      }}
                    >
                      Restore
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
