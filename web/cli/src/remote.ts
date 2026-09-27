/**
 * What `status` reads from the box, loosely: apps (the app registry merged
 * with live state), health and the system summary are read field by field,
 * every field optional, so a CLI a release ahead of the box or behind it
 * still prints a useful status rather than failing on a shape it did not
 * expect. The files API's types come from the shared package: those the CLI
 * relies on exactly.
 */

export interface AppSummary {
  id: string;
  name?: string;
  port?: number;
  listening?: boolean;
  pinned?: boolean;
  visibility?: { mode?: string; expiresAt?: number | null };
}

/** The part of `GET /api/system` that `status` summarises. */
export interface SystemSummary {
  sandbox?: { cpu?: number | null; memory?: number; processes?: number };
  host?: { cores?: number; memory?: number };
  container?: { cpu?: { limit?: number | null }; memory?: { used?: number | null; limit?: number | null } };
  disks?: Array<{ label?: string; path?: string; total?: number; available?: number }>;
  uptime?: { box?: number | null };
  versions?: { agentbox?: string | null; herdr?: string | null };
}

export interface HealthInfo {
  ok?: boolean;
  herdr?: { connected?: boolean; version?: string | null };
  workspaceRoot?: string;
  homeRoot?: string;
}
