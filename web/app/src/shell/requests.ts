import { create } from "zustand";

/**
 * Requests one part of the app makes of a surface that may not be built yet
 * — "New project" from the palette before Home has ever been shown. Kept in a
 * store rather than sent as an event, so a surface that mounts afterwards
 * still finds the request waiting and takes it.
 */
interface Requests {
  newProject: null | "clone" | "empty";
}

export const useRequests = create<Requests>(() => ({ newProject: null }));

export function requestNewProject(kind: "clone" | "empty" = "clone"): void {
  useRequests.setState({ newProject: kind });
}
