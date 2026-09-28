import type {
  App,
  AppView,
  AppVisibilityMode,
  DirEntry,
  ListeningPort,
  ReviewComment,
  ReviewSession,
  ReviewSessionDetail,
  SessionSnapshot,
} from "@workbench/shared";
import { apiUrl } from "./base.ts";

export class RpcError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "RpcError";
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { headers: { accept: "application/json" } });
  if (!res.ok) throw new RpcError(res.status, `${path} → ${res.status}`);
  return (await res.json()) as T;
}

/**
 * A JSON call whose refusal carries a sentence for a person (the gate's and
 * the app API's `{error, message}`): that sentence becomes the error.
 */
async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: body === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { message?: unknown; error?: unknown };
    const message = typeof d.message === "string" ? d.message : typeof d.error === "string" ? d.error : `${path} → ${res.status}`;
    throw new RpcError(res.status, message);
  }
  return data as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new RpcError(res.status, `${path} → ${res.status}`);
  return (await res.json()) as T;
}

/** Call a herdr method through the bridge's allowlisted RPC endpoint. */
export async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(apiUrl("/api/rpc"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!res.ok) throw new RpcError(res.status, body.error ?? `${method} → ${res.status}`);
  return body.result as T;
}

export interface HealthInfo {
  ok: boolean;
  herdr: { connected: boolean; version: string | null; protocol: number | null };
  workspaceRoot: string;
  /** The files API's second root (hidden in Files unless asked for). */
  homeRoot?: string;
  /** Whether the operator allows sharing apps; the Preview panel hides Share if not. */
  sharing: boolean;
}

export function getHealth(): Promise<HealthInfo> {
  return getJson<HealthInfo>("/api/health");
}

export function getSession(): Promise<SessionSnapshot> {
  return getJson<SessionSnapshot>("/api/session");
}

export function getPorts(): Promise<ListeningPort[]> {
  return getJson<ListeningPort[]>("/api/ports");
}

export function getReviewSessions(): Promise<ReviewSession[]> {
  return getJson<ReviewSession[]>("/api/review/sessions");
}

export function getReviewSession(key: string): Promise<ReviewSessionDetail> {
  return getJson<ReviewSessionDetail>(`/api/review/${key}`);
}

/** The artifact route, which the panel frames and full screen opens. */
export function reviewArtifactUrl(key: string): string {
  return apiUrl(`/api/review/${key}/artifact`);
}

/** Hand the agent what the human wrote; `end` closes the session with it. */
export async function postReviewFeedback(
  key: string,
  comments: ReviewComment[],
  end = false,
): Promise<ReviewSessionDetail> {
  return postJson<ReviewSessionDetail>(`/api/review/${key}/feedback`, { comments, end });
}

export function endReviewSession(key: string): Promise<ReviewSession> {
  return postJson<ReviewSession>(`/api/review/${key}/end`, { by: "human" });
}

export function listDirs(path: string): Promise<DirEntry[]> {
  return getJson<DirEntry[]>(`/api/fs/dirs?path=${encodeURIComponent(path)}`);
}

// --- apps ---------------------------------------------------------------------

/** Every app, with what is live of it in the sandbox. */
export function listApps(): Promise<AppView[]> {
  return getJson<AppView[]>("/api/apps");
}

/**
 * Make an app of a listening port, as the owner. Through the gate's own side:
 * the sandbox's side would record it as an agent's.
 */
export function makeApp(port: number, name?: string): Promise<App & { url: string }> {
  return send("POST", "/_gate/apps", { port, ...(name ? { name } : {}) });
}

/** Change what the sandbox may change of an app: its name, port, path fixes, pin. */
export function updateApp(id: string, fields: Partial<Pick<App, "name" | "port" | "compat" | "pinned">>): Promise<AppView> {
  return send("PATCH", `/api/apps/${id}`, fields);
}

export interface ShareRequest {
  mode: AppVisibilityMode;
  /** Seconds from now; null for until sharing is stopped. */
  expiresIn: number | null;
  /** For `passcode`; left out to keep the current one. */
  passcode?: string;
}

/** Start an app's command again (in the herdr tab it ran in, or a new one). */
export function restartApp(id: string): Promise<unknown> {
  return send("POST", `/api/apps/${id}/restart`, {});
}

/**
 * Who may open the app: the owner's decision, on the gate's side. Asked for a
 * passcode without one, for an app that has none, the gate makes one and
 * hands it back here, once.
 */
export function shareApp(id: string, req: ShareRequest): Promise<App & { passcode?: string }> {
  return send("PUT", `/_gate/apps/${id}/visibility`, req);
}

/** Private again; anyone still connected as the public is cut off. */
export function stopSharing(id: string): Promise<App> {
  return send("DELETE", `/_gate/apps/${id}/visibility`);
}

/** The state of an app, as the panel's probe reads it. */
export interface Probe {
  state: "ready" | "down";
  /** The gate could not fix every path the page names: it assumes it runs at `/`. */
  hint: string | null;
}

/**
 * Probe an app before framing it. The data plane marks every answer it gives
 * on the app's behalf — nothing listening, nothing answering — with
 * `X-Preview-Upstream: down`. Anything else came from the app itself, error
 * statuses included, and is the app's to show, so it is "ready". A GET for a
 * page (the body is dropped unread) so the gate's path fixes run, and say
 * whether they reached everything.
 */
export async function probeApp(url: string): Promise<Probe> {
  try {
    const ctl = new AbortController();
    const res = await fetch(url, { cache: "no-store", headers: { accept: "text/html" }, signal: ctl.signal });
    const probe: Probe = {
      state: res.headers.get("x-preview-upstream") === "down" ? "down" : "ready",
      hint: res.headers.get("x-agentbox-hint"),
    };
    ctl.abort();
    return probe;
  } catch {
    return { state: "down", hint: null };
  }
}
