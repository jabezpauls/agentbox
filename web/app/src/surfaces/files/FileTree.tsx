import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ChevronRight, Folder, FolderOpen, House, Trash2, Box } from "lucide-react";
import type { FileEntry } from "@workbench/shared";
import { filesApi } from "../../files/api.ts";
import { isWithin } from "../../files/paths.ts";
import { carriesFiles } from "../../files/drop.ts";
import { DRAG_TYPE } from "./FileList.tsx";
import { isDirLike } from "./icons.tsx";

interface Root {
  path: string;
  label: string;
  kind: "workspace" | "home";
}

interface Props {
  roots: Root[];
  current: string;
  trash: boolean;
  trashCount: number | null;
  /** Bumped when something changed, so open folders re-read. */
  version: number;
  hidden: boolean;
  onOpen(path: string): void;
  onTrash(): void;
  onDrop(folder: string, e: DragEvent): void;
}

type Children = { status: "loading" } | { status: "ready"; dirs: FileEntry[] } | { status: "error" };

interface Row {
  path: string;
  name: string;
  level: number;
  root?: Root;
  hasChildren: boolean;
}

/**
 * The folder tree beside the list: the workspace (and home, when shown),
 * folders only, read as they are opened. It follows the list — the folder
 * you are in is open and marked — and every folder in it takes a drop.
 */
export function FileTree({ roots, current, trash, trashCount, version, hidden, onOpen, onTrash, onDrop }: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(roots.map((r) => r.path)));
  const [children, setChildren] = useState<Map<string, Children>>(new Map());
  const [focus, setFocus] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const ref = useRef<HTMLUListElement>(null);

  const load = useCallback(
    (path: string) => {
      setChildren((m) => (m.get(path)?.status === "ready" ? m : new Map(m).set(path, { status: "loading" })));
      filesApi
        .list(path, { hidden, limit: 1000 })
        .then((l) => setChildren((m) => new Map(m).set(path, { status: "ready", dirs: l.entries.filter(isDirLike) })))
        .catch(() => setChildren((m) => new Map(m).set(path, { status: "error" })));
    },
    [hidden],
  );

  // Open every folder on the way to the one shown, and that one.
  useEffect(() => {
    if (trash) return;
    const root = roots.find((r) => isWithin(current, r.path));
    if (!root) return;
    setOpen((prev) => {
      const next = new Set(prev);
      let p = root.path;
      next.add(p);
      for (const name of current.slice(root.path.length).split("/").filter(Boolean)) {
        p = `${p === "/" ? "" : p}/${name}`;
        next.add(p);
      }
      return next;
    });
  }, [current, roots, trash]);

  // Read a folder when it opens, and every open folder again whenever
  // something changed (or hidden files were turned on or off).
  const seen = useRef<{ version: number; load: typeof load } | null>(null);
  const known = useRef(children);
  known.current = children;
  useEffect(() => {
    const again = seen.current?.version !== version || seen.current?.load !== load;
    seen.current = { version, load };
    for (const p of open) if (again || !known.current.has(p)) load(p);
  }, [open, version, load]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (path: string, level: number) => {
      const c = children.get(path);
      if (!open.has(path) || c?.status !== "ready") return;
      for (const d of c.dirs) {
        const kids = children.get(d.path);
        out.push({ path: d.path, name: d.name, level, hasChildren: kids?.status !== "ready" || kids.dirs.length > 0 });
        walk(d.path, level + 1);
      }
    };
    for (const r of roots) {
      out.push({ path: r.path, name: r.label, level: 1, root: r, hasChildren: true });
      walk(r.path, 2);
    }
    return out;
  }, [roots, open, children]);

  const toggle = (path: string, to?: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (to ?? !next.has(path)) next.add(path);
      else next.delete(path);
      return next;
    });

  const onKeyDown = (e: KeyboardEvent) => {
    const i = rows.findIndex((r) => r.path === focus);
    const row = rows[i];
    const go = (n: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, n))];
      if (target) {
        setFocus(target.path);
        document.getElementById(`tree-${encodeURIComponent(target.path)}`)?.focus();
      }
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(rows.length - 1);
    else if (e.key === "ArrowRight" && row) {
      if (!open.has(row.path)) toggle(row.path, true);
      else go(i + 1);
    } else if (e.key === "ArrowLeft" && row) {
      if (open.has(row.path) && !row.root) toggle(row.path, false);
      else {
        const parent = rows.slice(0, i).reverse().find((r) => r.level < row.level);
        if (parent) go(rows.indexOf(parent));
      }
    } else if ((e.key === "Enter" || e.key === " ") && row) onOpen(row.path);
    else return;
    e.preventDefault();
  };

  const dragOver = (e: DragEvent, path: string) => {
    if (!carriesFiles(e.dataTransfer) && !Array.from(e.dataTransfer.types).includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = carriesFiles(e.dataTransfer) || e.altKey || e.ctrlKey ? "copy" : "move";
    setDropOn(path);
  };

  const tabStop = focus ?? current;

  return (
    <nav className="ftree" aria-label="Folders">
      <ul className="ftree-list" role="tree" aria-label="Folders" ref={ref} onKeyDown={onKeyDown}>
        {rows.map((r) => {
          const expanded = open.has(r.path);
          const active = !trash && r.path === current;
          const Icon = r.root ? (r.root.kind === "home" ? House : Box) : expanded ? FolderOpen : Folder;
          return (
            <li
              key={r.path}
              role="treeitem"
              id={`tree-${encodeURIComponent(r.path)}`}
              aria-level={r.level}
              aria-expanded={r.hasChildren ? expanded : undefined}
              aria-selected={active}
              tabIndex={r.path === tabStop ? 0 : -1}
              className={`ftree-row${active ? " is-active" : ""}${r.root ? " is-root" : ""}${dropOn === r.path ? " is-drop" : ""}`}
              style={{ ["--level" as string]: r.level - 1 }}
              onFocus={() => setFocus(r.path)}
              onClick={() => onOpen(r.path)}
              onDragOver={(e) => dragOver(e, r.path)}
              onDragLeave={() => setDropOn((d) => (d === r.path ? null : d))}
              onDrop={(e) => {
                e.preventDefault();
                setDropOn(null);
                onDrop(r.path, e);
              }}
            >
              <span
                className={`ftree-chevron${expanded ? " is-open" : ""}${r.hasChildren ? "" : " is-leaf"}`}
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(r.path);
                }}
              >
                <ChevronRight size={12} />
              </span>
              <Icon size={14} strokeWidth={1.75} aria-hidden="true" className="ftree-icon" />
              <span className="ftree-name">{r.name}</span>
            </li>
          );
        })}
      </ul>
      <button className={`ftree-trash${trash ? " is-active" : ""}`} onClick={onTrash} aria-current={trash ? "page" : undefined}>
        <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="ftree-name">Trash</span>
        {trashCount !== null && trashCount > 0 && <span className="ftree-count">{trashCount}</span>}
      </button>
    </nav>
  );
}
