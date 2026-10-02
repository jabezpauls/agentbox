import { create } from "zustand";

/**
 * How each pane takes typing: predictive echo (on by default) and the compose
 * bar (off by default). Settings → Terminal holds the defaults; a pane's own
 * menu overrides them for that pane. Kept in this browser.
 */
export type ModeKey = "predict" | "compose";

interface ModesState {
  predict: boolean;
  compose: boolean;
  panes: Record<string, Partial<Record<ModeKey, boolean>>>;
  setDefault(key: ModeKey, on: boolean): void;
  setPane(paneId: string, key: ModeKey, on: boolean): void;
}

const KEY = "agentbox.terminalModes";
const MAX_PANES = 200;

function load(): Pick<ModesState, "predict" | "compose" | "panes"> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<ModesState>;
    return {
      predict: v.predict !== false,
      compose: v.compose === true,
      panes: v.panes && typeof v.panes === "object" ? v.panes : {},
    };
  } catch {
    return { predict: true, compose: false, panes: {} };
  }
}

function save(s: Pick<ModesState, "predict" | "compose" | "panes">): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ predict: s.predict, compose: s.compose, panes: s.panes }));
  } catch {
    // Best-effort: the choice still holds for this session.
  }
}

export const useTermModes = create<ModesState>((set, get) => ({
  ...load(),
  setDefault(key, on) {
    set({ [key]: on });
    save(get());
  },
  setPane(paneId, key, on) {
    const panes = { ...get().panes, [paneId]: { ...get().panes[paneId], [key]: on } };
    // A pane's choice outlives the pane only so far: herdr reuses ids.
    const ids = Object.keys(panes);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PANES))) delete panes[id];
    set({ panes });
    save(get());
  },
}));

/** Whether `key` is on for a pane: its own choice, else the default. */
export function paneMode(s: Pick<ModesState, ModeKey | "panes">, paneId: string, key: ModeKey): boolean {
  return s.panes[paneId]?.[key] ?? s[key];
}

/** Which panes are showing the alternate screen (a full-screen program). */
export const useAltScreen = create<Record<string, boolean>>(() => ({}));

const HISTORY_KEY = "agentbox.composeHistory";
const HISTORY_MAX = 100;

function readHistories(): Record<string, string[]> {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

/** A pane's compose history, oldest first. */
export function loadHistory(paneId: string): string[] {
  const h = readHistories()[paneId];
  return Array.isArray(h) ? h.filter((x) => typeof x === "string") : [];
}

/** Remember a sent line for a pane (not a repeat of the last one). */
export function pushHistory(paneId: string, line: string): string[] {
  const all = readHistories();
  const h = Array.isArray(all[paneId]) ? all[paneId] : [];
  if (line.trim() && h[h.length - 1] !== line) h.push(line);
  all[paneId] = h.slice(-HISTORY_MAX);
  const ids = Object.keys(all);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PANES))) delete all[id];
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  } catch {
    // Best-effort.
  }
  return all[paneId];
}
