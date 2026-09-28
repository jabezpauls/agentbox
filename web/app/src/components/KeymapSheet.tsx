import { useRef } from "react";
import { X } from "lucide-react";
import { useApp } from "../store/app.ts";
import { BINDINGS, type Binding } from "../keys/actions.ts";
import { useFocusTrap } from "./ui/focus.ts";
import { SURFACES } from "../shell/surfaces.ts";
import { chordLabel, isMacPlatform, paletteLabel } from "../shell/keys.ts";

const GROUPS: Binding["group"][] = ["Panes", "Tabs", "Workspaces", "View"];

interface Row {
  keys: string[];
  label: string;
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="keymap-keys">
      {keys.map((k, i) =>
        k === "then" || k === "or" ? (
          <span key={i} className="keymap-then">
            {k}
          </span>
        ) : (
          <kbd key={i} className="kbd">
            {k}
          </kbd>
        ),
      )}
    </span>
  );
}

function Group({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section className="keymap-group">
      <h3 className="section-label keymap-group-title">{title}</h3>
      <ul className="keymap-list">
        {rows.map((r) => (
          <li key={r.label} className="keymap-row">
            <Keys keys={r.keys} />
            <span className="keymap-label">{r.label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The keymap sheet (?, ⌃⌥/, prefix+? or the palette): every shortcut in the
 * app. The shell's own keys work everywhere — terminals and the editor too —
 * and were picked because neither browsers nor VS Code bind them.
 */
export function KeymapSheet() {
  const isOpen = useApp((s) => s.ui.dialog?.kind === "keymap");
  const setUi = useApp((s) => s.setUi);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setUi({ dialog: null });
  useFocusTrap(ref, isOpen, { onEscape: close });

  if (!isOpen) return null;

  const mac = isMacPlatform();
  const mod = mac ? "⌘" : "Ctrl+";
  const everywhere: Row[] = [
    { keys: [paletteLabel(mac)], label: "Search everything (not in the editor)" },
    { keys: [chordLabel("k", mac)], label: "Search everything, from anywhere" },
    ...SURFACES.map((s) => ({ keys: [chordLabel(s.key, mac)], label: s.id === "settings" ? "Settings" : `Go to ${s.label}` })),
    { keys: [chordLabel("d", mac)], label: "Open or close the dock" },
    { keys: ["?", "or", chordLabel("/", mac)], label: "Show these shortcuts" },
  ];
  const letters: Row[] = SURFACES.map((s) => ({ keys: ["G", "then", s.letter.toUpperCase()], label: s.label }));
  const files: Row[] = [
    { keys: ["↑", "↓"], label: "Move; with ⇧, select as you go" },
    { keys: ["↵"], label: "Open the folder, or look at the file" },
    { keys: ["Space"], label: "Quick look" },
    { keys: ["⌫", "or", `${mod}↑`], label: "Up a folder" },
    { keys: ["F2"], label: "Rename" },
    { keys: ["Del", "or", `${mod}⌫`], label: "Move to the trash" },
    { keys: [`${mod}A`], label: "Select everything" },
    { keys: ["A–Z"], label: "Jump to a name" },
    { keys: ["← →"], label: "Previous or next file, in quick look" },
  ];

  return (
    <div className="scrim" onMouseDown={close}>
      <div
        ref={ref}
        className="keymap-sheet pop-in"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="keymap-head">
          <div>
            <h2 className="keymap-title">Keyboard</h2>
            <p className="keymap-sub">
              {chordLabel("", mac).replace(/\+?$/, "")} with a key works everywhere, the editor and terminals included. In the editor, {paletteLabel(mac)} is VS
              Code's own.
            </p>
          </div>
          <button className="icon-btn" data-close onClick={close} aria-label="Close" title="Close">
            <X size={15} />
          </button>
        </header>

        <div className="keymap-body">
          <div className="keymap-grid">
            <Group title="Everywhere" rows={everywhere} />
            <div className="keymap-stack">
              <Group title="Where nothing is being typed" rows={letters} />
              <Group title="Files" rows={files} />
            </div>
          </div>
          <h3 className="keymap-part">
            The Workbench — press <kbd className="kbd">⌃B</kbd>, then a key. Twice sends a literal ⌃B.
          </h3>
          <div className="keymap-grid">
            {GROUPS.map((group) => (
              <Group
                key={group}
                title={group}
                rows={BINDINGS.filter((b) => b.group === group).map((b) => ({ keys: ["⌃B", b.keys], label: b.label }))}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
