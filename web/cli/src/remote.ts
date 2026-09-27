/**
 * The shapes of the box's answers the CLI reads, where the shared package
 * does not define them: apps (the app registry, merged with live state by the
 * bridge) are read loosely, field by field, so a box a release ahead or
 * behind still gets a useful `status`.
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
