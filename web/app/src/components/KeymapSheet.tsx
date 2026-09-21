import { useEffect } from "react";
import { X } from "lucide-react";
import { useApp } from "../store/app.ts";
import { BINDINGS, type Binding } from "../keys/actions.ts";

const GROUPS: Binding["group"][] = ["Panes", "Tabs", "Workspaces", "View"];

/**
 * The keymap sheet (prefix+?). A quiet modal listing the default herdr bindings,
 * grouped, each shown as the prefix pill plus its follow-up key. Dismissed by
 * Escape, the backdrop, or the close button.
 */
export function KeymapSheet() {
  const isOpen = useApp((s) => s.ui.dialog?.kind === "keymap");
  const setUi = useApp((s) => s.setUi);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setUi({ dialog: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, setUi]);

  if (!isOpen) return null;

  const close = () => setUi({ dialog: null });

  return (
    <div className="sheet-scrim" onMouseDown={close}>
      <div
        className="keymap-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="keymap-head">
          <div>
            <h2 className="keymap-title">Keyboard</h2>
            <p className="keymap-sub">
              Press <kbd className="kbd">⌃B</kbd> to arm the prefix, then a key. Twice sends a literal ⌃B.
            </p>
          </div>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="keymap-grid">
          {GROUPS.map((group) => (
            <section key={group} className="keymap-group">
              <h3 className="keymap-group-title">{group}</h3>
              <ul className="keymap-list">
                {BINDINGS.filter((b) => b.group === group).map((b) => (
                  <li key={b.id} className="keymap-row">
                    <span className="keymap-keys">
                      <kbd className="kbd">⌃B</kbd>
                      <kbd className="kbd">{b.keys}</kbd>
                    </span>
                    <span className="keymap-label">{b.label}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
