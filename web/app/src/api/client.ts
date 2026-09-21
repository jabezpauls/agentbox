import type {
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
  previewDomain: string | null;
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
