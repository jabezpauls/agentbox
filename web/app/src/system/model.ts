import { create } from "zustand";
import type { SystemInfo } from "@workbench/shared";
import { errorText, http } from "../api/http.ts";

/** One reading kept for the trend lines. */
export interface Sample {
  at: number;
  /** CPUs busy across the sandbox. */
  cpu: number | null;
  /** Resident bytes across the sandbox. */
  memory: number;
}

/** About two minutes at the System surface's pace. */
const HISTORY = 60;

interface SystemState {
  info: SystemInfo | null;
  error: string | null;
  history: Sample[];
  refresh(): Promise<void>;
}

/**
 * `GET /api/system`, shared by the Home strip and the System surface, with a
 * short history of CPU and memory so a trend can be drawn. Read only while
 * one of them is showing.
 */
export const useSystem = create<SystemState>((set) => ({
  info: null,
  error: null,
  history: [],
  async refresh() {
    try {
      const info = await http.get<SystemInfo>("/api/system");
      set((s) => {
        const last = s.history[s.history.length - 1];
        const history = last?.at === info.at ? s.history : [...s.history, { at: info.at, cpu: info.sandbox.cpu, memory: info.sandbox.memory }].slice(-HISTORY);
        return { info, error: null, history };
      });
    } catch (err) {
      set({ error: errorText(err, "The box did not answer.") });
    }
  },
}));

/** How loaded a share is: calm, getting full, or nearly out. */
export type Load = "ok" | "warn" | "high";

export function loadOf(fraction: number | null): Load {
  if (fraction === null || !Number.isFinite(fraction)) return "ok";
  if (fraction >= 0.9) return "high";
  if (fraction >= 0.75) return "warn";
  return "ok";
}
