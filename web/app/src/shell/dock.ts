import type { SurfaceId } from "./routes.ts";

/**
 * The dock's shape per surface. The dock is one panel shared by every
 * surface — the same Preview and Review, kept live — but whether it is open
 * and how wide it is are remembered for each surface: open beside the
 * terminals, closed over Files, say. The first visit to a surface keeps
 * whatever the dock was doing.
 */
export interface DockShape {
  open: boolean;
  width: number;
}

const KEY = "agentbox.dock";

export const DOCK_MIN = 320;
/** The widest the dock may be, as a share of the window. */
export const DOCK_MAX_SHARE = 0.6;

/** The widest the dock may be beside a surface in a `viewport`-wide window. */
export function dockMaxWidth(viewport: number): number {
  return Math.max(DOCK_MIN, Math.round(viewport * DOCK_MAX_SHARE));
}

export function clampDockWidth(width: number, viewport: number): number {
  return Math.min(dockMaxWidth(viewport), Math.max(DOCK_MIN, Math.round(width)));
}

type Memory = Partial<Record<SurfaceId, DockShape>>;

export function readDockMemory(): Memory {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Memory = {};
    for (const [k, v] of Object.entries(parsed)) {
      const shape = v as Partial<DockShape> | null;
      if (shape && typeof shape.open === "boolean" && typeof shape.width === "number") {
        out[k as SurfaceId] = { open: shape.open, width: shape.width };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberDock(surface: SurfaceId, shape: DockShape): void {
  try {
    const memory = readDockMemory();
    memory[surface] = shape;
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // Private mode or blocked storage: the shape holds for this session only.
  }
}

/**
 * Moving from `from` to `to`: remember the dock as it is for `from`, and say
 * how it should be on `to` — as it was left there, or as it is now if `to`
 * has never been seen.
 */
export function dockOnSwitch(from: SurfaceId, to: SurfaceId, current: DockShape): DockShape {
  rememberDock(from, current);
  return readDockMemory()[to] ?? current;
}
