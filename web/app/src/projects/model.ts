import { create } from "zustand";
import type { Project, ProjectCloneEvent, ProjectCloneStart } from "@workbench/shared";
import { http } from "../api/http.ts";

/** A clone in progress (or just ended), as the events socket reports it. */
export type Clone = ProjectCloneEvent;

interface ProjectsState {
  projects: Project[] | null;
  error: string | null;
  /** Clones by id; finished ones linger briefly so their end is seen. */
  clones: Record<string, Clone>;
  refresh(): Promise<void>;
  onClone(e: ProjectCloneEvent): void;
  dismissClone(id: string): void;
}

/** How long a finished clone's card stays, so "done" or the error is read. */
const LINGER_MS = 6000;

export const projectsApi = {
  list: () => http.get<Project[]>("/api/projects"),
  create: (name: string) => http.post<Project>("/api/projects", { name }),
  clone: (url: string, name?: string) => http.post<ProjectCloneStart>("/api/projects/clone", name ? { url, name } : { url }),
  cancelClone: (id: string) => http.del<void>(`/api/projects/clone/${encodeURIComponent(id)}`),
};

/**
 * The workspace's projects — its top-level folders — for Home and the
 * palette, plus the clones running into it.
 */
export const useProjects = create<ProjectsState>((set, get) => ({
  projects: null,
  error: null,
  clones: {},

  async refresh() {
    try {
      const projects = await projectsApi.list();
      set({ projects: [...projects].sort((a, b) => b.lastChange - a.lastChange), error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  onClone(e) {
    set((s) => ({ clones: { ...s.clones, [e.id]: { ...s.clones[e.id], ...e } } }));
    if (e.phase === "done" || e.phase === "cancelled" || e.phase === "error") {
      if (e.phase === "done") void get().refresh();
      // An error stays until dismissed; the rest go on their own.
      if (e.phase !== "error") setTimeout(() => get().dismissClone(e.id), e.phase === "done" ? 1200 : LINGER_MS);
    }
  },

  dismissClone(id) {
    set((s) => {
      const clones = { ...s.clones };
      delete clones[id];
      return { clones };
    });
  },
}));
