import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "@workbench/shared";
import { apiUrl } from "../api/base.ts";
import { download, filesApi, rawUrl } from "../files/api.ts";
import { basename, dirname, isWithin } from "../files/paths.ts";
import * as sel from "../files/selection.ts";
import { collectPicked } from "../files/drop.ts";
import { uploads } from "../files/uploads.ts";
import { DRAG_TYPE, FileList, type Sort } from "../surfaces/files/FileList.tsx";
import { isDirLike } from "../surfaces/files/icons.tsx";
import { moveInto, moveToTrash, newFile, newFolder, rename as renameEntry } from "../surfaces/files/actions.ts";
import { useListing } from "../surfaces/files/useListing.ts";

/**
 * Files on a machine: the folders its policy allows, each `read` or `write`,
 * with the Workbench's own file list and actions against `/m/<id>` — browse,
 * open in the editor, upload, download, rename, delete (to the machine's own
 * trash, kept 7 days). What the machine never shows or never lets be written
 * reads as missing or is refused there, whatever this page asks.
 */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders first, then by the chosen column (as Files sorts). */
function sortEntries(entries: FileEntry[], sort: Sort): FileEntry[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const by = (a: FileEntry, b: FileEntry) => (sort.key === "size" ? a.size - b.size : sort.key === "mtime" ? a.mtime - b.mtime : collator.compare(a.name, b.name));
  return [...entries].sort((a, b) => Number(isDirLike(b)) - Number(isDirLike(a)) || sign * by(a, b) || collator.compare(a.name, b.name));
}

export interface MachineRoot {
  path: string;
  mode: "read" | "write";
}

function Editor({ path, writable, onClose }: { path: string; writable: boolean; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  useEffect(() => {
    let live = true;
    fetch(rawUrl(path, true), { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `${r.status}`);
        if (!String(r.headers.get("content-type")).startsWith("text/plain")) throw new Error("This file is not text; download it instead.");
        return r.text();
      })
      .then(
        (t) => live && setText(t),
        (e: Error) => live && setError(e.message),
      );
    return () => {
      live = false;
    };
  }, [path]);
  const save = () => {
    if (text === null) return;
    setError(null);
    filesApi.write(path, text, true).then(
      () => setSaved(true),
      (e: Error) => setError(e.message),
    );
  };
  return (
    <div className="mx-editor" id="machine-editor" data-path={path}>
      <div className="mx-toolbar">
        <strong className="mx-editor-name">{basename(path)}</strong>
        {!saved && <span className="mx-hint">edited</span>}
        <span className="mx-spacer" />
        {writable && (
          <button className="btn btn-small btn-primary" type="button" id="machine-editor-save" disabled={text === null || saved} onClick={save}>
            Save
          </button>
        )}
        <button className="btn btn-small" type="button" onClick={() => download(rawUrl(path))}>
          Download
        </button>
        <button className="btn btn-small btn-ghost" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {error && (
        <p className="mx-error" role="alert">
          {error}
        </p>
      )}
      {text !== null && (
        <textarea
          className="mx-editor-text"
          spellCheck={false}
          readOnly={!writable}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSaved(false);
          }}
        />
      )}
    </div>
  );
}

export function MachineFiles({ roots }: { roots: MachineRoot[] }) {
  const [root, setRoot] = useState<MachineRoot | null>(roots[0] ?? null);
  const [dir, setDir] = useState<string | null>(roots[0]?.path ?? null);
  const [selection, setSelection] = useState<sel.Selection>(sel.EMPTY);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>({ key: "name", dir: "asc" });
  const [editing, setEditing] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const { listing, refresh, loadMore } = useListing(dir, false);

  useEffect(() => {
    if (!root && roots[0]) {
      setRoot(roots[0]);
      setDir(roots[0].path);
    }
  }, [roots, root]);

  const entries = useMemo(() => (listing.truncated ? listing.entries : sortEntries(listing.entries, sort)), [listing.entries, listing.truncated, sort]);
  const order = useMemo(() => entries.map((e) => e.path), [entries]);
  const taken = useMemo(() => new Set(listing.entries.map((e) => e.name)), [listing.entries]);
  useEffect(() => setSelection((s) => sel.prune(s, order)), [order]);
  useEffect(() => {
    setSelection(sel.EMPTY);
    setRenaming(null);
  }, [dir]);
  useEffect(() => {
    const t = setInterval(() => void refresh(), 5_000);
    const off = uploads.onComplete(() => void refresh());
    return () => {
      clearInterval(t);
      off();
    };
  }, [refresh]);

  const changed = useCallback(() => void refresh(), [refresh]);
  const writable = root?.mode === "write";
  const here = listing.dir || dir || "";
  const selected = sel.ordered(selection, order);
  const one = selected.length === 1 ? listing.entries.find((e) => e.path === selected[0]) : undefined;

  if (!root) return <p className="mx-hint">This machine&apos;s policy.json allows no folders.</p>;

  const open = (e: FileEntry) => {
    if (isDirLike(e)) setDir(e.path);
    else setEditing(e.path);
  };
  const up = () => {
    const parent = dirname(here);
    if (parent !== here && isWithin(parent, root.path)) setDir(parent);
  };

  return (
    <div className="mx-files" id="machine-files" data-dir={here}>
      <div className="mx-toolbar">
        <select
          className="input mx-root"
          aria-label="Folder"
          value={root.path}
          onChange={(e) => {
            const r = roots.find((x) => x.path === e.target.value) ?? null;
            setRoot(r);
            setDir(r?.path ?? null);
            setEditing(null);
          }}
        >
          {roots.map((r) => (
            <option key={r.path} value={r.path}>
              {r.path}
              {r.mode === "read" ? " (read only)" : ""}
            </option>
          ))}
        </select>
        <button className="btn btn-small" type="button" disabled={here === root.path} onClick={up}>
          Up
        </button>
        <span className="mx-hint mx-path">{here}</span>
        <span className="mx-spacer" />
        {writable && (
          <>
            <button className="btn btn-small" type="button" onClick={() => void newFolder(here, taken, changed)}>
              New folder
            </button>
            <button className="btn btn-small" type="button" onClick={() => void newFile(here, taken, (p) => (changed(), setEditing(p)))}>
              New file
            </button>
            <button className="btn btn-small" type="button" onClick={() => picker.current?.click()}>
              Upload
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) uploads.add(collectPicked(e.target.files, here).files);
                e.target.value = "";
              }}
            />
          </>
        )}
        <button className="btn btn-small" type="button" disabled={!one || isDirLike(one)} onClick={() => one && download(rawUrl(one.path))}>
          Download
        </button>
        {writable && (
          <>
            <button className="btn btn-small" type="button" disabled={!one} onClick={() => one && setRenaming(one.path)}>
              Rename
            </button>
            <button className="btn btn-small" type="button" disabled={selected.length === 0} onClick={() => void moveToTrash(selected, changed)}>
              Delete
            </button>
          </>
        )}
      </div>
      {listing.status === "error" || listing.status === "missing" ? (
        <p className="mx-error" role="alert">
          {listing.error ?? "This folder cannot be read."}
        </p>
      ) : null}
      <div className="mx-files-body">
        <div className="mx-files-list">
          <FileList
            entries={entries}
            selection={selection}
            onSelection={setSelection}
            sort={sort}
            onSort={setSort}
            sortable={!listing.truncated}
            renaming={renaming}
            onRenameStart={(e) => writable && setRenaming(e.path)}
            onRenameCancel={() => setRenaming(null)}
            onRenameCommit={(e, name) => {
              setRenaming(null);
              void renameEntry(e, name, () => changed());
            }}
            onOpen={open}
            onQuickLook={open}
            onUp={up}
            onTrash={(paths) => writable && void moveToTrash(paths, changed)}
            onMenu={() => {}}
            onDrop={(folder, e) => {
              if (!writable) return;
              const into = folder ?? here;
              const internal = e.dataTransfer.getData(DRAG_TYPE);
              if (internal) {
                try {
                  void moveInto(JSON.parse(internal) as string[], into, changed);
                } catch {
                  // Not ours.
                }
                return;
              }
              if (e.dataTransfer.files.length) uploads.add(collectPicked(e.dataTransfer.files, into).files);
            }}
            onEndReached={() => void loadMore()}
            label={`Files in ${basename(here)}`}
            empty={<p className="mx-hint">{listing.status === "loading" ? "Loading…" : "This folder is empty."}</p>}
          />
        </div>
        {editing && <Editor key={editing} path={editing} writable={writable} onClose={() => setEditing(null)} />}
      </div>
    </div>
  );
}

/** The folders this machine's policy allows, as its node says. */
export function useMachineRoots(): { roots: MachineRoot[] | null; ports: boolean } {
  const [state, setState] = useState<{ roots: MachineRoot[] | null; ports: boolean }>({ roots: null, ports: false });
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(apiUrl("/api/health"), { credentials: "same-origin" })
        .then((r) => r.json() as Promise<{ machine?: { files?: MachineRoot[]; ports?: boolean } }>)
        .then((h) => live && setState({ roots: h.machine?.files ?? [], ports: h.machine?.ports === true }))
        .catch(() => {});
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return state;
}
