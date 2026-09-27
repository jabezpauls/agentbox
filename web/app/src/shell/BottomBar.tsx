import { useRef, useState } from "react";
import { Ellipsis, LogOut, Monitor, Moon, PanelRight, Search, Sun, X } from "lucide-react";
import { useApp } from "../store/app.ts";
import type { Theme } from "../theme/useTheme.ts";
import { useFocusTrap } from "../components/ui/focus.ts";
import { openPalette, toggleDock } from "./actions.ts";
import { useAttention } from "./attention.ts";
import { ConnLight } from "./Rail.tsx";
import { useRouter } from "./router.ts";
import type { SurfaceId } from "./routes.ts";
import { signOut } from "./session.ts";
import { BOTTOM_BAR, SURFACE_BY_ID } from "./surfaces.ts";

const MORE: SurfaceId[] = ["editor", "system", "settings"];

const THEMES: { id: Theme; label: string; icon: typeof Sun }[] = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

/** The phone's More sheet: what does not fit in the bottom bar. */
function MoreSheet({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const go = useRouter((s) => s.go);
  const current = useRouter((s) => s.route.surface);
  const theme = useApp((s) => s.ui.theme);
  const themeSet = useApp((s) => s.themeSet);
  useFocusTrap(ref, true, { onEscape: onClose });

  const pick = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <div className="scrim sheet-scrim" onMouseDown={onClose}>
      <div
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="More"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="sheet-grab" aria-hidden="true" />
        <header className="sheet-head">
          <h2 className="sheet-title">More</h2>
          <button className="icon-btn" data-close aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="sheet-tiles">
          {MORE.map((id) => {
            const m = SURFACE_BY_ID[id];
            const Icon = m.icon;
            return (
              <button
                key={id}
                className={`sheet-tile${current === id ? " is-active" : ""}`}
                aria-current={current === id ? "page" : undefined}
                onClick={pick(() => go(id))}
              >
                <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
                <span>{m.label}</span>
              </button>
            );
          })}
          <button className="sheet-tile" onClick={pick(() => toggleDock(true))}>
            <PanelRight size={20} strokeWidth={1.75} aria-hidden="true" />
            <span>Dock</span>
          </button>
        </div>
        <div className="sheet-list">
          <button className="sheet-row" onClick={pick(() => openPalette())}>
            <Search size={16} aria-hidden="true" />
            <span>Search everything</span>
          </button>
          <div className="sheet-row is-static">
            <span className="sheet-row-label">Theme</span>
            <div className="segmented" role="radiogroup" aria-label="Theme">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  role="radio"
                  aria-checked={theme === t.id}
                  className={`segmented-btn${theme === t.id ? " is-active" : ""}`}
                  onClick={() => themeSet?.(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="sheet-row is-static">
            <span className="sheet-row-label">{location.host}</span>
            <ConnLight withLabel />
          </div>
          <button className="sheet-row is-danger" onClick={pick(() => void signOut())}>
            <LogOut size={16} aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The phone's navigation: the four surfaces used one-handed most, and More
 * for the rest. Shown instead of the rail at 700px and below — the same app,
 * the same surfaces, only the frame changes.
 */
export function BottomBar() {
  const current = useRouter((s) => s.route.surface);
  const go = useRouter((s) => s.go);
  const attention = useAttention();
  const [more, setMore] = useState(false);
  const inMore = !BOTTOM_BAR.includes(current);

  return (
    <>
      <nav className="bottombar" aria-label="Surfaces">
        {BOTTOM_BAR.map((id) => {
          const m = SURFACE_BY_ID[id];
          const Icon = m.icon;
          const active = current === id;
          return (
            <button
              key={id}
              className={`bb-item${active ? " is-active" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => go(id)}
            >
              <span className="bb-icon">
                <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
                {attention[id] && <span className="rail-dot" aria-hidden="true" />}
              </span>
              <span className="bb-label">{m.label}</span>
              {attention[id] && <span className="sr-only">, needs you</span>}
            </button>
          );
        })}
        <button
          className={`bb-item${inMore ? " is-active" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={more}
          onClick={() => setMore(true)}
        >
          <span className="bb-icon">
            <Ellipsis size={20} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span className="bb-label">{inMore ? SURFACE_BY_ID[current].label : "More"}</span>
        </button>
      </nav>
      {more && <MoreSheet onClose={() => setMore(false)} />}
    </>
  );
}
