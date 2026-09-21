import { useEffect, useMemo, useRef, useState } from "react";
import { Columns2, MoreHorizontal, Pencil, Rows2, Maximize2, X } from "lucide-react";
import type { PaneInfo } from "@workbench/shared";
import { useApp } from "../store/app.ts";
import { rpc } from "../api/client.ts";
import { StatusBadge } from "./StatusBadge.tsx";

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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const agentName = agent?.display_agent ?? agent?.agent ?? pane.display_agent ?? pane.agent;
  const title = agentName || pane.terminal_title_stripped || pane.label || "shell";
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

  const split = (direction: "right" | "down") => {
    rpc("pane.split", { direction, target_pane_id: pane.pane_id, focus: true }).catch(() => {});
    setMenuOpen(false);
  };
  const zoom = () => {
    rpc("pane.zoom", { mode: "toggle", pane_id: pane.pane_id }).catch(() => {});
    setMenuOpen(false);
  };
  const close = () => {
    rpc("pane.close", { pane_id: pane.pane_id }).catch(() => {});
    setMenuOpen(false);
  };
  const startRename = () => {
    setMenuOpen(false);
    setDraft(pane.label ?? title);
    setEditing(true);
  };
  const commitRename = () => {
    const label = draft.trim();
    if (label && label !== pane.label) rpc("pane.rename", { pane_id: pane.pane_id, label }).catch(() => {});
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
        className="pane-menu-btn"
        aria-label={`Pane actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <MoreHorizontal size={14} />
      </button>

      {menuOpen && (
        <div className="ctx-menu pane-ctx" role="menu" id={menuId} ref={menuRef}>
          <button className="ctx-item" role="menuitem" onClick={() => split("right")}>
            <Columns2 size={14} /> Split right
          </button>
          <button className="ctx-item" role="menuitem" onClick={() => split("down")}>
            <Rows2 size={14} /> Split down
          </button>
          <button className="ctx-item" role="menuitem" onClick={zoom}>
            <Maximize2 size={14} /> Zoom
          </button>
          <button className="ctx-item" role="menuitem" onClick={startRename}>
            <Pencil size={14} /> Rename
          </button>
          <button className="ctx-item" role="menuitem" onClick={close}>
            <X size={14} /> Close pane
          </button>
        </div>
      )}
    </div>
  );
}
