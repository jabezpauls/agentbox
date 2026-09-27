import { Box, PanelRight, Search } from "lucide-react";
import { useApp } from "../store/app.ts";
import { Tooltip } from "../components/ui/Tooltip.tsx";
import { openPalette, toggleDock } from "./actions.ts";
import { chordLabel, paletteLabel } from "./keys.ts";
import { useRouter } from "./router.ts";
import type { SurfaceId } from "./routes.ts";
import { SURFACE_BY_ID, SURFACES, type SurfaceMeta } from "./surfaces.ts";
import { useAttention } from "./attention.ts";

const CONN = {
  connecting: { label: "Connecting", title: "Opening the connection to herdr." },
  open: { label: "Live", title: "Connected to herdr." },
  closed: { label: "Offline", title: "The connection to herdr dropped. Reconnecting." },
} as const;

function RailItem({ meta, active, badge }: { meta: SurfaceMeta; active: boolean; badge?: "attention" | undefined }) {
  const go = useRouter((s) => s.go);
  const Icon = meta.icon;
  return (
    <Tooltip label={meta.label} keys={chordLabel(meta.key)} side="right">
      <a
        href={meta.id === "home" ? "/" : `/${meta.id}`}
        className={`rail-item${active ? " is-active" : ""}`}
        aria-label={badge ? `${meta.label}, needs you` : meta.label}
        aria-current={active ? "page" : undefined}
        onClick={(e) => {
          // A plain click moves within the app; a modified one (new tab, new
          // window) is the browser's.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          go(meta.id);
        }}
      >
        <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
        {badge && <span className="rail-dot" aria-hidden="true" />}
      </a>
    </Tooltip>
  );
}

/** The connection to herdr, as a light at the foot of the rail. */
export function ConnLight({ withLabel = false }: { withLabel?: boolean }) {
  const status = useApp((s) => s.status);
  const c = CONN[status];
  return (
    <span className={`conn-pill is-${status}${withLabel ? "" : " is-compact"}`} title={c.title} role="status">
      <span className="conn-dot" aria-hidden="true" />
      <span className={withLabel ? undefined : "sr-only"}>{c.label}</span>
    </span>
  );
}

/**
 * The rail: one icon per surface, a label and its shortcut on hover or
 * focus. Settings, the palette, the dock and the connection light sit at the
 * foot. A surface that needs you — an agent waiting, a review to answer —
 * carries a dot.
 */
export function Rail() {
  const current = useRouter((s) => s.route.surface);
  const dockOpen = useApp((s) => s.ui.inspector.open);
  const attention = useAttention();
  const main = SURFACES.filter((s) => s.id !== "settings");
  const badge = (id: SurfaceId) => (attention[id] ? ("attention" as const) : undefined);

  return (
    <nav className="rail" aria-label="Surfaces">
      <div className="rail-brand" title={`agentbox · ${location.host}`}>
        <Box size={18} strokeWidth={2} aria-hidden="true" />
        <span className="sr-only">agentbox</span>
      </div>
      <div className="rail-items">
        {main.map((m) => (
          <RailItem key={m.id} meta={m} active={current === m.id} badge={badge(m.id)} />
        ))}
      </div>
      <div className="rail-foot">
        <Tooltip label="Search" keys={paletteLabel()} side="right">
          <button className="rail-item" aria-label="Search" onClick={() => openPalette()}>
            <Search size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label={dockOpen ? "Close the dock" : "Open the dock"} keys={chordLabel("d")} side="right">
          <button
            className={`rail-item${dockOpen ? " is-on" : ""}`}
            aria-label="Dock"
            aria-pressed={dockOpen}
            onClick={() => toggleDock()}
          >
            <PanelRight size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </Tooltip>
        <RailItem meta={SURFACE_BY_ID.settings} active={current === "settings"} />
        <ConnLight />
      </div>
    </nav>
  );
}
