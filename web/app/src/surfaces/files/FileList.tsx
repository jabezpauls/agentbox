import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowDown, ArrowUp, CornerDownRight, MoreHorizontal } from "lucide-react";
import type { FileEntry } from "@workbench/shared";
import { formatAgo, formatBytes } from "../../lib/format.ts";
import { splitExt } from "../../files/paths.ts";
import { carriesFiles } from "../../files/drop.ts";
import { stepTypeAhead } from "../../files/typeahead.ts";
import { goSequence } from "../../shell/actions.ts";
import * as sel from "../../files/selection.ts";
import type { Selection } from "../../files/selection.ts";
import { GitMark, iconFor, isDirLike } from "./icons.tsx";

export type SortKey = "name" | "size" | "mtime";
export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

/** The drag payload for rows moved within Files. */
export const DRAG_TYPE = "application/x-agentbox-paths";

interface Props {
  entries: FileEntry[];
  selection: Selection;
  onSelection(s: Selection): void;
  sort: Sort;
  onSort(s: Sort): void;
  /** Sorting is only honest over what is loaded; a partial folder sorts by name. */
  sortable: boolean;
  renaming: string | null;
  onRenameCommit(entry: FileEntry, name: string): void;
  onRenameCancel(): void;
  onRenameStart(entry: FileEntry): void;
  onOpen(entry: FileEntry): void;
  onQuickLook(entry: FileEntry): void;
  onUp(): void;
  onTrash(paths: string[]): void;
  onMenu(entry: FileEntry | null, at: { x: number; y: number } | HTMLElement): void;
  /** A drop onto a folder row (or onto the list, `folder` null = the folder shown). */
  onDrop(folder: string | null, e: DragEvent): void;
  onEndReached(): void;
  /** Shown when the folder is empty. */
  empty: React.ReactNode;
  label: string;
}

const OVERSCAN = 8;

function rowHeight(): number {
  return typeof matchMedia === "function" && matchMedia("(max-width: 700px)").matches ? 48 : 36;
}

function RenameField({ entry, onCommit, onCancel }: { entry: FileEntry; onCommit(name: string): void; onCancel(): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const stem = isDirLike(entry) ? entry.name.length : splitExt(entry.name)[0].length;
    el.setSelectionRange(0, stem);
  }, [entry]);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(ref.current?.value.trim() ?? entry.name);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      className="flist-rename"
      defaultValue={entry.name}
      aria-label={`Rename ${entry.name}`}
      spellCheck={false}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}

function SortHeader({ label, k, sort, onSort, sortable, className }: { label: string; k: SortKey; sort: Sort; onSort(s: Sort): void; sortable: boolean; className: string }) {
  const active = sort.key === k;
  return (
    <div role="columnheader" className={`flist-h ${className}`} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        className={`flist-sort${active ? " is-active" : ""}`}
        disabled={!sortable && k !== "name"}
        title={!sortable && k !== "name" ? "Load the whole folder to sort it by this" : `Sort by ${label.toLowerCase()}`}
        onClick={() => onSort({ key: k, dir: active && sort.dir === "asc" ? "desc" : "asc" })}
      >
        {label}
        {active && (sort.dir === "asc" ? <ArrowUp size={11} aria-hidden="true" /> : <ArrowDown size={11} aria-hidden="true" />)}
      </button>
    </div>
  );
}

/**
 * The file list: a grid of rows the keyboard walks like a desktop file
 * manager (see selection.ts, and the keymap sheet), with drag to move, drop
 * to upload, inline rename and a menu per row. Only the rows in view are
 * drawn, so a folder of thousands scrolls as lightly as one of ten.
 */
export function FileList(p: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [row, setRow] = useState(rowHeight);
  const [view, setView] = useState({ top: 0, height: 600 });
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const lastPointer = useRef<string>("mouse");

  const order = p.entries.map((e) => e.path);
  const byPath = new Map(p.entries.map((e) => [e.path, e]));
  const cursor = p.selection.cursor;
  const cursorIndex = cursor ? order.indexOf(cursor) : -1;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      setRow(rowHeight());
      setView({ top: el.scrollTop, height: el.clientHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(view.top / row) - OVERSCAN);
  const last = Math.min(p.entries.length, Math.ceil((view.top + view.height) / row) + OVERSCAN);

  useEffect(() => {
    if (last >= p.entries.length - 20) p.onEndReached();
    // Only when the window of drawn rows reaches the end.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last, p.entries.length]);

  // Keep the keyboard's row in view.
  const reveal = useCallback(
    (index: number) => {
      const el = scroller.current;
      if (!el || index < 0) return;
      const top = index * row;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + row > el.scrollTop + el.clientHeight) el.scrollTop = top + row - el.clientHeight;
    },
    [row],
  );
  useEffect(() => reveal(cursorIndex), [cursorIndex, reveal]);

  const set = (s: Selection) => p.onSelection(s);
  const selectedPaths = () => sel.ordered(p.selection, order);

  const onKeyDown = (e: KeyboardEvent) => {
    if (p.renaming) return;
    const mod = e.metaKey || e.ctrlKey;
    const page = Math.max(1, Math.floor(view.height / row) - 1);
    const at = cursor ? byPath.get(cursor) : undefined;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (mod && at) p.onOpen(at);
        else set(sel.move(p.selection, order, 1, e.shiftKey));
        return;
      case "ArrowUp":
        e.preventDefault();
        if (mod || e.altKey) p.onUp();
        else set(sel.move(p.selection, order, -1, e.shiftKey));
        return;
      case "PageDown":
        e.preventDefault();
        set(sel.move(p.selection, order, page, e.shiftKey));
        return;
      case "PageUp":
        e.preventDefault();
        set(sel.move(p.selection, order, -page, e.shiftKey));
        return;
      case "Home":
        e.preventDefault();
        set(sel.edge(p.selection, order, "start", e.shiftKey));
        return;
      case "End":
        e.preventDefault();
        set(sel.edge(p.selection, order, "end", e.shiftKey));
        return;
      case "Enter":
        e.preventDefault();
        if (at) p.onOpen(at);
        return;
      case " ":
        e.preventDefault();
        if (at) p.onQuickLook(at);
        return;
      case "Backspace":
        e.preventDefault();
        if (mod) p.onTrash(selectedPaths());
        else p.onUp();
        return;
      case "Delete":
        e.preventDefault();
        p.onTrash(selectedPaths());
        return;
      case "F2":
        e.preventDefault();
        if (at) p.onRenameStart(at);
        return;
      case "Escape":
        if (p.selection.selected.size > 0) {
          e.preventDefault();
          set(sel.EMPTY);
        }
        return;
      case "ContextMenu":
        e.preventDefault();
        openMenuForCursor();
        return;
      case "F10":
        if (e.shiftKey) {
          e.preventDefault();
          openMenuForCursor();
        }
        return;
    }
    if (mod && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      set(sel.selectAll(order));
      return;
    }
    // Type to jump: letters typed together find the next name starting with
    // them — sharing the keyboard with ? and the g sequences (typeahead.ts).
    if (!mod && !e.altKey && e.key.length === 1 && /\S/.test(e.key)) {
      const step = stepTypeAhead(typeahead.current, e.key, Date.now(), (k) => goSequence.takes(k));
      if (step.kind === "pass") return;
      if (!step.share) {
        e.preventDefault();
        goSequence.reset();
      }
      const start = step.fresh ? cursorIndex + 1 : Math.max(0, cursorIndex);
      const rotated = [...order.slice(start), ...order.slice(0, start)];
      const hit = rotated.find((path) => (byPath.get(path)?.name.toLowerCase() ?? "").startsWith(step.query));
      if (hit) set(sel.only(hit));
    }
  };

  const openMenuForCursor = () => {
    const at = cursor ? byPath.get(cursor) : undefined;
    const el = cursor ? document.getElementById(rowId(cursor)) : null;
    if (at && el) p.onMenu(at, el.querySelector<HTMLElement>(".flist-more") ?? el);
    else if (grid.current) p.onMenu(null, grid.current);
  };

  const onRowClick = (e: MouseEvent, entry: FileEntry) => {
    grid.current?.focus({ preventScroll: true });
    // A tap on a phone opens, as a tap does everywhere else there; a click
    // selects, as it does on a desktop.
    if (lastPointer.current === "touch" && p.selection.selected.size <= 1 && !e.shiftKey) {
      set(sel.only(entry.path));
      p.onOpen(entry);
      return;
    }
    set(sel.click(p.selection, order, entry.path, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey }));
  };

  const onCheck = (entry: FileEntry) => {
    set(sel.click(p.selection, order, entry.path, { toggle: true }));
  };

  const onRowMenu = (e: MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    if (!p.selection.selected.has(entry.path)) set(sel.only(entry.path));
    p.onMenu(entry, { x: e.clientX, y: e.clientY });
  };

  const onDragStart = (e: DragEvent, entry: FileEntry) => {
    const paths = p.selection.selected.has(entry.path) ? selectedPaths() : [entry.path];
    if (!p.selection.selected.has(entry.path)) set(sel.only(entry.path));
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
    e.dataTransfer.setData("text/plain", paths.join("\n"));
    e.dataTransfer.effectAllowed = "copyMove";
    // Several rows travel as one chip saying how many.
    if (paths.length > 1) {
      const chip = document.createElement("div");
      chip.className = "drag-chip";
      chip.textContent = `${paths.length} items`;
      document.body.appendChild(chip);
      e.dataTransfer.setDragImage(chip, 12, 12);
      setTimeout(() => chip.remove(), 0);
    }
  };

  const acceptsDrop = (e: DragEvent) => carriesFiles(e.dataTransfer) || Array.from(e.dataTransfer.types).includes(DRAG_TYPE);

  const onRowDragOver = (e: DragEvent, entry: FileEntry) => {
    if (!isDirLike(entry) || !acceptsDrop(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const internal = Array.from(e.dataTransfer.types).includes(DRAG_TYPE);
    e.dataTransfer.dropEffect = internal && !(e.altKey || e.ctrlKey) ? "move" : "copy";
    setDropTarget(entry.path);
  };

  const rowId = (path: string) => `frow-${encodeURIComponent(path)}`;
  const rows = p.entries.slice(first, last);

  return (
    <div
      className="flist"
      role="grid"
      aria-label={p.label}
      aria-multiselectable="true"
      aria-rowcount={p.entries.length + 1}
      tabIndex={0}
      ref={grid}
      aria-activedescendant={cursor && cursorIndex >= 0 ? rowId(cursor) : undefined}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (!cursor && order.length > 0) set({ ...p.selection, cursor: order[0]!, anchor: order[0]! });
      }}
      onContextMenu={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("flist-scroll")) {
          e.preventDefault();
          p.onMenu(null, { x: e.clientX, y: e.clientY });
        }
      }}
    >
      <div className="flist-head" role="row" aria-rowindex={1}>
        <div role="columnheader" className="flist-h c-check" aria-label="Selected" />
        <SortHeader label="Name" k="name" className="c-name" sort={p.sort} onSort={p.onSort} sortable={p.sortable} />
        <SortHeader label="Modified" k="mtime" className="c-mtime" sort={p.sort} onSort={p.onSort} sortable={p.sortable} />
        <SortHeader label="Size" k="size" className="c-size" sort={p.sort} onSort={p.onSort} sortable={p.sortable} />
        <div role="columnheader" className="flist-h c-more" aria-label="Actions" />
      </div>
      <div
        className="flist-scroll"
        ref={scroller}
        onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
        onPointerDown={(e) => {
          lastPointer.current = e.pointerType;
          if (e.target === e.currentTarget) set(sel.EMPTY);
        }}
        onDragOver={(e) => {
          if (!carriesFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDropTarget(null);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDropTarget(null);
          p.onDrop(null, e);
        }}
      >
        {p.entries.length === 0 ? (
          p.empty
        ) : (
          <div className="flist-body" style={{ height: p.entries.length * row, ["--row-h" as string]: `${row}px` }}>
            {rows.map((entry, n) => {
              const i = first + n;
              const Icon = iconFor(entry);
              const selected = p.selection.selected.has(entry.path);
              const isCursor = entry.path === cursor;
              const dirLike = isDirLike(entry);
              return (
                <div
                  key={entry.path}
                  id={rowId(entry.path)}
                  role="row"
                  aria-label={entry.name}
                  aria-rowindex={i + 2}
                  aria-selected={selected}
                  className={`frow${selected ? " is-selected" : ""}${isCursor ? " is-cursor" : ""}${dropTarget === entry.path ? " is-drop" : ""}${entry.git === "ignored" ? " is-ignored" : ""}`}
                  style={{ top: i * row }}
                  draggable={p.renaming !== entry.path}
                  onClick={(e) => onRowClick(e, entry)}
                  onDoubleClick={() => p.onOpen(entry)}
                  onContextMenu={(e) => onRowMenu(e, entry)}
                  onDragStart={(e) => onDragStart(e, entry)}
                  onDragOver={(e) => onRowDragOver(e, entry)}
                  onDragLeave={() => setDropTarget((t) => (t === entry.path ? null : t))}
                  onDrop={(e) => {
                    if (!dirLike) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setDropTarget(null);
                    p.onDrop(entry.path, e);
                  }}
                >
                  <div role="gridcell" className="fcell c-check">
                    <input
                      type="checkbox"
                      className="frow-check"
                      tabIndex={-1}
                      checked={selected}
                      aria-label={`Select ${entry.name}`}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => onCheck(entry)}
                    />
                  </div>
                  <div role="gridcell" className="fcell c-name">
                    <span className={`frow-icon${dirLike ? " is-dir" : ""}`} aria-hidden="true">
                      <Icon size={16} strokeWidth={1.75} />
                    </span>
                    {p.renaming === entry.path ? (
                      <RenameField entry={entry} onCommit={(name) => p.onRenameCommit(entry, name)} onCancel={p.onRenameCancel} />
                    ) : (
                      <span className="frow-name" title={entry.name}>
                        {entry.name}
                      </span>
                    )}
                    {entry.type === "symlink" && (
                      <span className="frow-link" title={`Link to ${entry.target ?? "?"}${entry.targetType ? "" : " (outside, or missing)"}`}>
                        <CornerDownRight size={12} aria-hidden="true" />
                        <span className="frow-link-target">{entry.target}</span>
                      </span>
                    )}
                    {entry.git && <GitMark status={entry.git} />}
                  </div>
                  <div role="gridcell" className="fcell c-mtime" title={new Date(entry.mtime).toLocaleString()}>
                    {formatAgo(entry.mtime)}
                  </div>
                  <div role="gridcell" className="fcell c-size">
                    {dirLike ? "—" : formatBytes(entry.size)}
                  </div>
                  <div role="gridcell" className="fcell c-more">
                    <button
                      className="icon-btn is-sm flist-more"
                      tabIndex={-1}
                      aria-label={`Actions for ${entry.name}`}
                      aria-haspopup="menu"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!p.selection.selected.has(entry.path)) set(sel.only(entry.path));
                        p.onMenu(entry, e.currentTarget);
                      }}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
