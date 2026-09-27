import { AppWindow, Code2, Folder, Gauge, House, Settings, SquareTerminal, type LucideIcon } from "lucide-react";
import type { SurfaceId } from "./routes.ts";

export interface SurfaceMeta {
  id: SurfaceId;
  label: string;
  icon: LucideIcon;
  /** The key after ⌃⌥ (Ctrl+Alt) that goes here, from anywhere — the editor and terminals too. */
  key: string;
  /** The letter after `g` that goes here, from anywhere keys are not typed into something. */
  letter: string;
  /** One line for the palette and the rail's tooltip. */
  hint: string;
}

/**
 * The surfaces, in rail order. Settings sits apart at the bottom of the rail
 * and in the More sheet on a phone.
 */
export const SURFACES: SurfaceMeta[] = [
  { id: "home", label: "Home", icon: House, key: "1", letter: "h", hint: "What needs you, your projects and apps" },
  { id: "workbench", label: "Workbench", icon: SquareTerminal, key: "2", letter: "w", hint: "Agents and terminals" },
  { id: "editor", label: "Editor", icon: Code2, key: "3", letter: "e", hint: "VS Code, kept running" },
  { id: "files", label: "Files", icon: Folder, key: "4", letter: "f", hint: "Browse, upload and download" },
  { id: "apps", label: "Apps", icon: AppWindow, key: "5", letter: "a", hint: "Dev servers, previews and sharing" },
  { id: "system", label: "System", icon: Gauge, key: "6", letter: "s", hint: "CPU, memory, disks and processes" },
  { id: "settings", label: "Settings", icon: Settings, key: ",", letter: ",", hint: "Account, devices, sharing and appearance" },
];

export const SURFACE_BY_ID = Object.fromEntries(SURFACES.map((s) => [s.id, s])) as Record<SurfaceId, SurfaceMeta>;

/** The phone's bottom bar; the rest live in the More sheet. */
export const BOTTOM_BAR: SurfaceId[] = ["home", "workbench", "files", "apps"];
