import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Columns2, MoreHorizontal, Pencil, Rows2, Maximize2, X } from "lucide-react";
import type { PaneInfo } from "@workbench/shared";
import { useApp } from "../store/app.ts";
import { call } from "../api/call.ts";
import { paneTitle } from "../store/session.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { paneMode, useTermModes, type ModeKey } from "../terminal/modes.ts";

interface Props {
  pane: PaneInfo;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1) || "/";
}

/**
 * The slim chrome above each terminal: the pane's best title, its agent state,
 * the working directory, and an overflow menu. Deliberately quiet — a single
 * hairline under it, no heavy border, so the terminals carry the weight.
 */
export function PaneHeader({ pane }: Props) {
  const agent = useApp((s) => s.session.agents[pane.pane_id]);
  const [menuOpen, setMenuOpen] = useState(false);
  const compose = useTermModes((s) => paneMode(s, pane.pane_id, "compose"));
  const predict = useTermModes((s) => paneMode(s, pane.pane_id, "predict"));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  // Suppresses the focus-return-to-trigger behaviour for one close, used when
  // the menu closes because focus deliberately left it (a Tab-out).
  const skipRefocus = useRef(false);

  const title = paneTitle(pane, agent);
  const cwd = pane.foreground_cwd ?? pane.cwd ?? "";

  const menuId = useMemo(() => `pane-menu-${pane.pane_id}`, [pane.pane_id]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  // Same menu model as the tab bar's: focus moves into the menu on open and
  // back to its trigger on close, with arrows to walk it and Escape to leave.
  useEffect(() => {
    if (menuOpen) {
      menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    } else if (skipRefocus.current) {
      skipRefocus.current = false;
    } else {
      menuBtnRef.current?.focus();
    }
  }, [menuOpen]);

  // Close on a deliberate focus move out of the menu (e.g. Tab), without
  // pulling focus back to the trigger the way Escape and activation do.
  const onMenuBlur = (e: React.FocusEvent) => {
    if (!menuRef.current?.contains(e.relatedTarget as Node | null)) {
      skipRefocus.current = true;
      setMenuOpen(false);
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      setMenuOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
  };

  const split = (direction: "right" | "down") => {
    void call("pane.split", { direction, target_pane_id: pane.pane_id, focus: true });
    setMenuOpen(false);
  };
  const zoom = () => {
    void call("pane.zoom", { mode: "toggle", pane_id: pane.pane_id });
    setMenuOpen(false);
  };
  const close = () => {
    void call("pane.close", { pane_id: pane.pane_id });
    setMenuOpen(false);
  };
  const toggle = (key: ModeKey, on: boolean) => {
    useTermModes.getState().setPane(pane.pane_id, key, !on);
    setMenuOpen(false);
  };
  const startRename = () => {
    setMenuOpen(false);
    setDraft(pane.label ?? title);
    setEditing(true);
  };
  const commitRename = () => {
    const label = draft.trim();
    if (label && label !== pane.label) void call("pane.rename", { pane_id: pane.pane_id, label });
    setEditing(false);
  };

  return (
    <div className="pane-head">
      <StatusBadge status={pane.agent_status} muted={pane.agent_status === "unknown"} />
      {editing ? (
        <input
          ref={inputRef}
          className="pane-rename"
          aria-label={`Rename pane ${title}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span className="pane-title" title={title}>
          {title}
        </span>
      )}
      {cwd && (
        <span className="pane-cwd" title={cwd}>
          {basename(cwd)}
        </span>
      )}

      <button
        ref={menuBtnRef}
        className="icon-btn is-sm pane-menu-btn"
        aria-label={`Pane actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <MoreHorizontal size={13} />
      </button>

      {menuOpen && (
        <div className="ctx-menu pane-ctx" role="menu" id={menuId} ref={menuRef} onKeyDown={onMenuKeyDown} onBlur={onMenuBlur}>
          <button className="ctx-item" role="menuitem" onClick={() => split("right")}>
            <Columns2 size={14} /> Split right
          </button>
          <button className="ctx-item" role="menuitem" onClick={() => split("down")}>
            <Rows2 size={14} /> Split down
          </button>
          <button className="ctx-item" role="menuitem" onClick={zoom}>
            <Maximize2 size={14} /> Zoom
          </button>
          <button className="ctx-item" role="menuitemcheckbox" aria-checked={compose} onClick={() => toggle("compose", compose)}>
            <Check size={14} style={{ opacity: compose ? 1 : 0 }} /> Compose bar
          </button>
          <button className="ctx-item" role="menuitemcheckbox" aria-checked={predict} onClick={() => toggle("predict", predict)}>
            <Check size={14} style={{ opacity: predict ? 1 : 0 }} /> Predictive echo
          </button>
          <button className="ctx-item" role="menuitem" onClick={startRename}>
            <Pencil size={14} /> Rename
          </button>
          <button className="ctx-item is-danger" role="menuitem" onClick={close}>
            <X size={14} /> Close pane
          </button>
        </div>
      )}
    </div>
  );
}
