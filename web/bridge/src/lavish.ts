import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LavishSession, LavishState } from "@workbench/shared";
import type { Config } from "./config.js";

/** The subset of a persisted lavish-axi session we surface to the browser. */
interface StoredSession {
  key?: string;
  file?: string;
  label?: string;
  status?: string;
}

interface HealthResponse {
  ok?: boolean;
  listeners?: { key?: string; label?: string }[];
}

const HEALTH_TIMEOUT_MS = 800;

/** Fetch lavish-axi's `/health`, returning null if it is not answering. */
async function fetchHealth(port: number): Promise<HealthResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readState(stateFile: string): Promise<StoredSession[]> {
  let raw: string;
  try {
    raw = await readFile(stateFile, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { sessions?: Record<string, StoredSession> };
    const sessions = parsed.sessions ?? {};
    return Object.values(sessions).filter(
      (s): s is StoredSession => typeof s === "object" && s !== null,
    );
  } catch {
    return [];
  }
}

/**
 * Describe the lavish-axi review sessions for the browser. lavish-axi cannot
 * live under this bridge's path prefix, so we only read its persisted state and
 * link sessions to the hostname it was configured for. When it is not
 * configured (`config.lavishUrl` unset) nothing is read and it reports as such.
 */
export async function readLavishSessions(config: Config): Promise<LavishState> {
  if (!config.lavishUrl) {
    return { configured: false, url: null, running: false, sessions: [] };
  }

  const stateFile = path.join(config.lavishStateDir, "state.json");
  const [stored, health] = await Promise.all([
    readState(stateFile),
    fetchHealth(config.lavishPort),
  ]);

  const running = health?.ok === true;
  const activeKeys = new Set(
    (health?.listeners ?? [])
      .map((l) => l.key)
      .filter((k): k is string => typeof k === "string"),
  );

  const sessions: LavishSession[] = stored
    .filter((s): s is StoredSession & { key: string; file: string } =>
      typeof s.key === "string" && typeof s.file === "string",
    )
    .map((s) => ({
      key: s.key,
      label: s.label ?? path.basename(s.file),
      file: s.file,
      status: s.status ?? "unknown",
      url: `${config.lavishUrl}/session/${s.key}`,
      active: activeKeys.has(s.key),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));

  return { configured: true, url: config.lavishUrl, running, sessions };
}
