import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  AppWindow,
  Bot,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Code2,
  Copy,
  Download,
  Eye,
  EyeOff,
  FilePlus2,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderUp,
  House,
  ListFilter,
  PanelLeft,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  SquareTerminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { FileEntry, TrashItem } from "@workbench/shared";
import { useApp } from "../../store/app.ts";
import { filesApi } from "../../files/api.ts";
import { basename, dirname, isWithin, join, trimSlash } from "../../files/paths.ts";
import * as sel from "../../files/selection.ts";
import { carriesFiles, collectDrop, collectPicked } from "../../files/drop.ts";
import { uploads } from "../../files/uploads.ts";
import { previewKind } from "../../files/preview.ts";
import { useSystem } from "../../system/model.ts";
import { formatBytes, plural } from "../../lib/format.ts";
import { Menu, type MenuAnchor, type MenuEntry } from "../../components/ui/Menu.tsx";
import { Empty } from "../../components/ui/Page.tsx";
import { focusOnArrival, openModal, useOnActivate, usePolling, useSurfaceActive } from "../../shell/activity.tsx";
import { openInEditor } from "../../shell/editor.ts";
import { useRouter } from "../../shell/router.ts";
import { useNarrow } from "../../shell/Dock.tsx";
import { agentHere, agentLabel, launchableAgents, runHere, terminalHere } from "../../workbench/launch.ts";
import {
  copyPaths,
  downloadPaths,
  duplicate,
  moveInto,
  moveToTrash,
  newFile,
  newFolder,
  rename as renameEntry,
} from "./actions.ts";
import { DRAG_TYPE, FileList, type Sort } from "./FileList.tsx";
import { FileTree } from "./FileTree.tsx";
import { isDirLike } from "./icons.tsx";
import { QuickLook } from "./QuickLook.tsx";
import { TrashView } from "./TrashView.tsx";
import { useListing } from "./useListing.ts";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    // Remembered for this page only.
  }
}

function readSort(): Sort {
  try {
    const v = JSON.parse(localStorage.getItem("agentbox.files.sort") ?? "null") as Sort | null;
    if (v && ["name", "size", "mtime"].includes(v.key) && ["asc", "desc"].includes(v.dir)) return v;
  } catch {
    // default
  }
  return { key: "name", dir: "asc" };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders first, then by the chosen column. */
export function sortEntries(entries: FileEntry[], sort: Sort): FileEntry[] {
  const dirFirst = (a: FileEntry, b: FileEntry) => Number(isDirLike(b)) - Number(isDirLike(a));
  const by = (a: FileEntry, b: FileEntry) => {
    if (sort.key === "size") return a.size - b.size;
    if (sort.key === "mtime") return a.mtime - b.mtime;
    return collator.compare(a.name, b.name);
  };
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => dirFirst(a, b) || sign * by(a, b) || collator.compare(a.name, b.name));
}

interface Crumb {
  path: string;
  label: string;
  root?: "workspace" | "home";
}

function crumbsFor(dir: string, roots: { workspace: string; home: string }, trash: boolean): Crumb[] {
  if (trash) return [{ path: roots.workspace, label: "Trash" }];
  for (const [kind, base, label] of [
    ["workspace", roots.workspace, "Workspace"],
    ["home", roots.home, "Home"],
  ] as const) {
    if (!isWithin(dir, base)) continue;
    const out: Crumb[] = [{ path: base, label, root: kind }];
    let p = trimSlash(base);
    for (const name of dir.slice(p.length).split("/").filter(Boolean)) {
      p = join(p, name);
      out.push({ path: p, label: name });
    }
    return out;
  }
  const out: Crumb[] = [{ path: "/", label: "/" }];
  let p = "";
  for (const name of dir.split("/").filter(Boolean)) {
    p = `${p}/${name}`;
    out.push({ path: p, label: name });
  }
  return out;
}

/**
 * Files: the workspace as a file manager — a folder tree and a list, drag to
 * move, drop files or whole folders to upload, rename in place, the trash
 * with undo, quick look, git marks, and from any file the editor, a
 * terminal or an agent right there.
 *
 * The route is the path (`/files/workspace/proj/src`): a folder shows its
 * contents; a file shows its folder with the file in quick look.
 */
export function FilesSurface() {
  const route = useRouter((s) => s.route);
  const navigate = useRouter((s) => s.navigate);
  const health = useApp((s) => s.health);
  const active = useSurfaceActive();
  const narrow = useNarrow();
  const roots = useMemo(
    () => ({ workspace: health?.workspaceRoot ?? "/workspace", home: health?.homeRoot ?? "/home/coder" }),
    [health],
  );

  // The files route, remembered while another surface shows.
  const lastFiles = useRef(route.surface === "files" ? route : null);
  if (route.surface === "files") lastFiles.current = route;
  const here = lastFiles.current;
  const trash = here?.trash === true;
  // Nothing is read before the bridge has said where the roots are.
  const asked = here?.path || roots.workspace;
  const home = asked === "~" ? roots.home : asked.startsWith("~/") ? join(roots.home, asked.slice(2)) : null;
  const target = health ? (home ?? asked) : null;

  const [hidden, setHidden] = useState(() => readFlag("agentbox.files.hidden", false));
  const [showHome, setShowHome] = useState(() => readFlag("agentbox.files.home", false));
  const [treeOpen, setTreeOpen] = useState(() => readFlag("agentbox.files.tree", true));
  const [sort, setSortState] = useState<Sort>(readSort);
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState<sel.Selection>(sel.EMPTY);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ entries: FileEntry[] | null; anchor: MenuAnchor } | null>(null);
  const [version, setVersion] = useState(0);
  const [trashItems, setTrashItems] = useState<TrashItem[] | null>(null);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const [stray, setStray] = useState<FileEntry | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const systemInfo = useSystem((s) => s.info);

  const { listing, refresh, loadMore } = useListing(trash ? null : target, hidden);
  const dir = listing.dir || target || roots.workspace;

  const setSort = (s: Sort) => {
    setSortState(s);
    try {
      localStorage.setItem("agentbox.files.sort", JSON.stringify(s));
    } catch {
      // Remembered for this page only.
    }
  };

  const entries = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const shown = q ? listing.entries.filter((e) => e.name.toLowerCase().includes(q)) : listing.entries;
    return listing.truncated ? shown : sortEntries(shown, sort);
  }, [listing.entries, listing.truncated, filter, sort]);
  const order = useMemo(() => entries.map((e) => e.path), [entries]);
  const byPath = useMemo(() => new Map(listing.entries.map((e) => [e.path, e])), [listing.entries]);
  const taken = useMemo(() => new Set(listing.entries.map((e) => e.name)), [listing.entries]);

  // Keep the selection to what is still there.
  useEffect(() => setSelection((s) => sel.prune(s, order)), [order]);
  // A new folder starts with nothing selected and no filter.
  useEffect(() => {
    setSelection(sel.EMPTY);
    setFilter("");
    setRenaming(null);
  }, [dir]);

  const changed = useCallback(() => {
    void refresh();
    setVersion((v) => v + 1);
  }, [refresh]);

  const loadTrash = useCallback(async () => {
    try {
      setTrashItems(await filesApi.trashList());
      setTrashError(null);
    } catch (err) {
      setTrashError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // What is in the folder changes under us (agents write files); read it
  // again every few seconds while Files is showing. A partial folder is left
  // alone — re-reading thousands of entries on a timer is not worth it.
  usePolling(() => (listing.truncated ? undefined : refresh()), 4000, !trash);
  usePolling(loadTrash, trash ? 5000 : 30_000);

  useEffect(() => {
    if (active && !systemInfo) void useSystem.getState().refresh();
  }, [active, systemInfo]);

  // A file that lands in (or below) this folder shows up at once.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = uploads.onComplete((item) => {
      if (!isWithin(item.dest, dir)) return;
      if (t) clearTimeout(t);
      t = setTimeout(changed, 250);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [dir, changed]);

  useOnActivate(() => focusOnArrival(() => grid.current?.querySelector<HTMLElement>(".flist")?.focus({ preventScroll: true })));

  // Quick look follows the route: a link to a file opens it.
  // Closing takes effect at once, not when the folder has been read again.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const lookPath = listing.file && listing.file !== dismissed ? listing.file : null;
  useEffect(() => {
    if (listing.file !== dismissed) setDismissed(null);
    // Only when the listing moves on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing.file]);
  const lookEntry = lookPath ? (byPath.get(lookPath) ?? (stray?.path === lookPath ? stray : null)) : null;
  useEffect(() => {
    if (!lookPath) return;
    setSelection(sel.only(lookPath));
    if (!byPath.has(lookPath)) {
      filesApi
        .stat(lookPath)
        .then(setStray)
        .catch(() => setStray(null));
    }
  }, [lookPath, byPath]);

  const go = (path: string) => navigate({ surface: "files", path });
  const quickLook = (e: FileEntry) => {
    setDismissed(null);
    navigate({ surface: "files", path: e.path }, { replace: true });
  };
  const closeLook = () => {
    setDismissed(listing.file);
    navigate({ surface: "files", path: dir }, { replace: true });
    requestAnimationFrame(() => {
      // Back to the list — unless something opened over it meanwhile.
      if (!openModal()) grid.current?.querySelector<HTMLElement>(".flist")?.focus({ preventScroll: true });
    });
  };

  const open = (e: FileEntry) => {
    if (isDirLike(e)) go(e.path);
    else quickLook(e);
  };

  const selectedEntries = () => sel.ordered(selection, order).map((p) => byPath.get(p)!).filter(Boolean);

  const trashPaths = (paths: string[]) => void moveToTrash(paths, changed);

  const onDrop = (folder: string | null, e: DragEvent) => {
    setDragDepth(0);
    const into = folder ?? dir;
    const internal = e.dataTransfer.getData(DRAG_TYPE);
    if (internal) {
      try {
        const paths = JSON.parse(internal) as string[];
        void moveInto(paths, into, changed, e.altKey || e.ctrlKey);
      } catch {
        // Not ours after all.
      }
      return;
    }
    if (!carriesFiles(e.dataTransfer)) return;
    void collectDrop(e.dataTransfer, into).then((c) => {
      if (c.files.length || c.emptyDirs.length) uploads.add(c.files, c.emptyDirs);
      if (c.emptyDirs.length && !c.files.length) setTimeout(changed, 300);
    });
  };

  const onPicked = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const c = collectPicked(list, dir);
    uploads.add(c.files, c.emptyDirs);
  };

  const agents = launchableAgents(systemInfo?.versions.agents ?? [{ name: "claude" }]);

  const menuItems = (targets: FileEntry[] | null): MenuEntry[] => {
    const folderActions = (path: string): MenuEntry[] => [
      { label: "Open in editor", icon: Code2, onSelect: () => void openInEditor(path) },
      { label: "Terminal here", icon: SquareTerminal, onSelect: () => void terminalHere(path) },
      ...agents.slice(0, 3).map((a) => ({ label: `${agentLabel(a)} here`, icon: Bot, onSelect: () => void agentHere(path, a) })),
    ];
    if (!targets || targets.length === 0) {
      return [
        { label: "New folder", icon: FolderPlus, onSelect: () => void newFolder(dir, taken, (p) => (changed(), setSelection(sel.only(p)))) },
        { label: "New file", icon: FilePlus2, onSelect: () => void newFile(dir, taken, (p) => (changed(), setSelection(sel.only(p)))) },
        { label: "Upload files…", icon: Upload, onSelect: () => filesInput.current?.click() },
        { label: "Upload a folder…", icon: FolderUp, onSelect: () => folderInput.current?.click() },
        { separator: true },
        ...folderActions(dir),
        { label: "Serve this folder as an app", icon: AppWindow, onSelect: () => void runHere(dir, "agentbox-preview static .", `serve ${basename(dir)}`) },
        { separator: true },
        { label: "Download as zip", icon: Download, onSelect: () => downloadPaths([{ ...(byPath.get(dir) ?? { name: basename(dir), path: dir, type: "dir", size: 0, mtime: 0 }) }], basename(dir)) },
        { label: "Copy path", icon: ClipboardCopy, onSelect: () => void copyPaths([dir]) },
      ];
    }
    if (targets.length > 1) {
      return [
        { heading: `${targets.length} items` },
        { label: "Download as zip", icon: Download, onSelect: () => downloadPaths(targets, basename(dir)) },
        { label: "Copy paths", icon: ClipboardCopy, onSelect: () => void copyPaths(targets.map((t) => t.path)) },
        { separator: true },
        { label: "Move to trash", icon: Trash2, keys: "Del", danger: true, onSelect: () => trashPaths(targets.map((t) => t.path)) },
      ];
    }
    const e = targets[0]!;
    const isDir = isDirLike(e);
    return [
      isDir
        ? { label: "Open", icon: FolderOpen, keys: "↵", onSelect: () => go(e.path) }
        : { label: "Quick look", icon: Eye, keys: "Space", disabled: previewKind(e) === "none", onSelect: () => quickLook(e) },
      ...(isDir
        ? folderActions(e.path)
        : [
            { label: "Open in editor", icon: Code2, onSelect: () => void openInEditor(e.path) },
            { label: "Terminal here", icon: SquareTerminal, onSelect: () => void terminalHere(dirname(e.path)) },
          ]),
      ...(isDir
        ? [{ label: "Serve as an app", icon: AppWindow, onSelect: () => void runHere(e.path, "agentbox-preview static .", `serve ${e.name}`) }]
        : []),
      { separator: true },
      { label: isDir ? "Download as zip" : "Download", icon: Download, onSelect: () => downloadPaths([e], e.name) },
      { label: "Copy path", icon: ClipboardCopy, onSelect: () => void copyPaths([e.path]) },
      { label: "Rename", icon: Pencil, keys: "F2", onSelect: () => setRenaming(e.path) },
      { label: "Duplicate", icon: Copy, onSelect: () => void duplicate(e, taken, (to) => (changed(), setSelection(sel.only(to)))) },
      { separator: true },
      { label: "Move to trash", icon: Trash2, keys: "Del", danger: true, onSelect: () => trashPaths([e.path]) },
    ];
  };

  const crumbs = crumbsFor(dir, roots, trash);
  const treeRoots = useMemo(
    () => [
      { path: roots.workspace, label: "Workspace", kind: "workspace" as const },
      ...(showHome ? [{ path: roots.home, label: "Home", kind: "home" as const }] : []),
    ],
    [roots, showHome],
  );

  const chosen = selectedEntries();
  const chosenSize = chosen.reduce((n, e) => n + (isDirLike(e) ? 0 : e.size), 0);
  const showBar = chosen.length > 1 || (narrow && chosen.length > 0);
  const external = dragDepth > 0;

  const viewMenuItems: MenuEntry[] = [
    {
      label: hidden ? "Hide hidden files" : "Show hidden files",
      icon: hidden ? EyeOff : Eye,
      onSelect: () => {
        setHidden(!hidden);
        writeFlag("agentbox.files.hidden", !hidden);
      },
    },
    {
      label: showHome ? "Hide the home folder" : "Show the home folder",
      icon: House,
      onSelect: () => {
        setShowHome(!showHome);
        writeFlag("agentbox.files.home", !showHome);
      },
    },
    {
      label: treeOpen ? "Hide the folder tree" : "Show the folder tree",
      icon: PanelLeft,
      onSelect: () => {
        setTreeOpen(!treeOpen);
        writeFlag("agentbox.files.tree", !treeOpen);
      },
    },
    { separator: true },
    { label: "Refresh", icon: RefreshCw, onSelect: changed },
  ];

  let body: React.ReactNode;
  if (trash) {
    body = <TrashView items={trashItems} error={trashError} onChange={() => (void loadTrash(), changed())} onReveal={go} />;
  } else if (listing.status === "missing") {
    body = (
      <Empty
        icon={<FolderInput size={22} />}
        title="Nothing lives here."
        sub={`${dir} is not there. It may have been moved, renamed or deleted.`}
        action={
          <button className="btn btn-small" onClick={() => go(roots.workspace)}>
            Go to the workspace
          </button>
        }
      />
    );
  } else if (listing.status === "error") {
    body = <Empty title="Couldn't read this folder." sub={listing.error} action={<button className="btn btn-small" onClick={changed}>Retry</button>} />;
  } else if (listing.status === "loading" && listing.entries.length === 0) {
    body = (
      <div className="flist is-loading" aria-busy="true" aria-label="Loading the folder">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="frow-skeleton">
            <div className="skeleton" style={{ width: 16, height: 16 }} />
            <div className="skeleton" style={{ width: `${30 + ((i * 37) % 40)}%`, height: 12 }} />
          </div>
        ))}
      </div>
    );
  } else {
    body = (
      <FileList
        entries={entries}
        selection={selection}
        onSelection={setSelection}
        sort={sort}
        onSort={setSort}
        sortable={!listing.truncated}
        renaming={renaming}
        onRenameStart={(e) => setRenaming(e.path)}
        onRenameCancel={() => setRenaming(null)}
        onRenameCommit={(e, name) => {
          setRenaming(null);
          void renameEntry(e, name, (to) => {
            changed();
            setSelection(sel.only(to));
          });
        }}
        onOpen={open}
        onQuickLook={(e) => (previewKind(e) === "none" && !isDirLike(e) ? quickLook(e) : isDirLike(e) ? go(e.path) : quickLook(e))}
        onUp={() => {
          const up = dirname(dir);
          if (up !== dir && (isWithin(up, roots.workspace) || isWithin(up, roots.home))) go(up);
        }}
        onTrash={trashPaths}
        onMenu={(entry, at) => setMenu({ entries: entry ? (selection.selected.has(entry.path) ? selectedEntries() : [entry]) : null, anchor: at })}
        onDrop={onDrop}
        onEndReached={() => void loadMore()}
        label={`Files in ${basename(dir)}`}
        empty={
          filter ? (
            <Empty compact title="Nothing matches that." sub="Try a shorter part of the name." />
          ) : (
            <Empty
              icon={<Upload size={22} />}
              title="This folder is empty."
              sub="Drop files or folders here to upload them, or make something new."
              action={
                <>
                  <button className="btn btn-small" onClick={() => filesInput.current?.click()}>
                    Upload files
                  </button>
                  <button className="btn btn-small btn-ghost" onClick={() => void newFolder(dir, taken, () => changed())}>
                    New folder
                  </button>
                </>
              }
            />
          )
        }
      />
    );
  }

  return (
    <div
      className={`files${treeOpen ? "" : " is-treeless"}${external ? " is-dropping" : ""}`}
      ref={grid}
      onDragEnter={(e) => carriesFiles(e.dataTransfer) && setDragDepth((d) => d + 1)}
      onDragLeave={(e) => carriesFiles(e.dataTransfer) && setDragDepth((d) => Math.max(0, d - 1))}
      onDrop={() => setDragDepth(0)}
    >
      <header className="files-bar">
        <nav className="crumbs files-crumbs" aria-label="Folder">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <span key={c.path + i} className="crumb-part">
                {i > 0 && <ChevronRight size={12} className="crumb-sep" aria-hidden="true" />}
                <button
                  className={`crumb${last ? " is-current" : ""}`}
                  aria-current={last ? "page" : undefined}
                  onClick={() => (trash ? undefined : go(c.path))}
                  onDragOver={(e) => {
                    if (trash || (!carriesFiles(e.dataTransfer) && !Array.from(e.dataTransfer.types).includes(DRAG_TYPE))) return;
                    e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    onDrop(c.path, e);
                  }}
                >
                  {i === 0 && c.root === "home" && <House size={13} aria-hidden="true" />}
                  {c.label}
                </button>
              </span>
            );
          })}
        </nav>
        {!trash && (
          <div className="files-tools">
            <label className="files-filter">
              <ListFilter size={14} aria-hidden="true" />
              <input
                ref={filterInput}
                className="files-filter-input"
                placeholder="Filter"
                aria-label="Filter this folder by name"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setFilter("");
                    grid.current?.querySelector<HTMLElement>(".flist")?.focus();
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    grid.current?.querySelector<HTMLElement>(".flist")?.focus();
                  }
                }}
              />
              {filter && (
                <button className="icon-btn is-sm" aria-label="Clear the filter" onClick={() => setFilter("")}>
                  <X size={12} />
                </button>
              )}
            </label>
            <button
              className="btn btn-small"
              aria-haspopup="menu"
              onClick={(e) =>
                setMenu({
                  entries: null,
                  anchor: e.currentTarget,
                })
              }
            >
              <FolderPlus size={14} aria-hidden="true" />
              <span className="hide-narrow">New</span>
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            <button className="btn btn-small btn-primary" onClick={() => filesInput.current?.click()}>
              <Upload size={14} aria-hidden="true" />
              <span className="hide-narrow">Upload</span>
            </button>
            <ViewMenu items={viewMenuItems} />
          </div>
        )}
      </header>
      {showBar && (
        <div className="files-selbar" role="toolbar" aria-label="Selection">
          <span className="files-selcount">
            {plural(chosen.length, "item")} selected{chosenSize ? ` · ${formatBytes(chosenSize)}` : ""}
          </span>
          <button className="btn btn-small btn-ghost" onClick={() => downloadPaths(chosen, basename(dir))}>
            <Download size={14} aria-hidden="true" />
            Download
          </button>
          <button className="btn btn-small btn-ghost is-danger" onClick={() => trashPaths(chosen.map((c) => c.path))}>
            <Trash2 size={14} aria-hidden="true" />
            Move to trash
          </button>
          <button className="icon-btn" aria-label="Clear the selection" onClick={() => setSelection(sel.EMPTY)}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="files-body">
        {treeOpen && !narrow && health && (
          <FileTree
            roots={treeRoots}
            current={listing.status === "ready" ? listing.dir : ""}
            trash={trash}
            trashCount={trashItems?.length ?? null}
            version={version}
            hidden={hidden}
            onOpen={go}
            onTrash={() => navigate({ surface: "files", path: "", trash: true })}
            onDrop={(folder, e) => onDrop(folder, e)}
          />
        )}
        <div className="files-main">
          {body}
          {!trash && listing.status === "ready" && (
            <footer className="files-status" aria-live="polite">
              <span>
                {filter ? `${entries.length} of ${plural(listing.total, "item")}` : plural(listing.total, "item")}
                {listing.truncated && ` · showing ${listing.entries.length.toLocaleString()}, scroll for more`}
              </span>
              {narrow && (
                <button className="linklike files-status-trash" onClick={() => navigate({ surface: "files", path: "", trash: true })}>
                  Trash{trashItems?.length ? ` (${trashItems.length})` : ""}
                </button>
              )}
            </footer>
          )}
          {external && !trash && (
            <div className="files-drop" aria-hidden="true">
              <Upload size={22} />
              <span>Drop to upload to {basename(dir)}</span>
            </div>
          )}
        </div>
      </div>

      <input ref={filesInput} type="file" multiple hidden onChange={(e) => (onPicked(e.target.files), (e.target.value = ""))} />
      <input
        ref={folderInput}
        type="file"
        hidden
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => (onPicked(e.target.files), (e.target.value = ""))}
      />

      {menu && (
        <Menu
          anchor={menu.anchor}
          label={menu.entries?.length === 1 ? `Actions for ${menu.entries[0]!.name}` : "Actions"}
          items={menuItems(menu.entries)}
          onClose={() => setMenu(null)}
        />
      )}
      {lookEntry && active && !isDirLike(lookEntry) && (
        <QuickLook entry={lookEntry} siblings={entries} onNavigate={quickLook} onClose={closeLook} />
      )}
    </div>
  );
}

function ViewMenu({ items }: { items: MenuEntry[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        className="icon-btn"
        aria-label="View options"
        title="View options"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        <SlidersHorizontal size={15} />
      </button>
      {anchor && <Menu anchor={anchor} label="View options" items={items} align="end" onClose={() => setAnchor(null)} />}
    </>
  );
}
