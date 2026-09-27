import type {
  DirEntry,
  ListeningPort,
  PreviewShare,
  ReviewComment,
  ReviewSession,
  ReviewSessionDetail,
  SessionSnapshot,
} from "@workbench/shared";
import { apiUrl, basePath } from "./base.ts";

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

async function del(path: string): Promise<void> {
  const res = await fetch(apiUrl(path), { method: "DELETE", headers: { accept: "application/json" } });
  if (!res.ok) throw new RpcError(res.status, `${path} → ${res.status}`);
}

export interface HealthInfo {
  ok: boolean;
  herdr: { connected: boolean; version: string | null; protocol: number | null };
  workspaceRoot: string;
  previewDomain: string | null;
  /** Whether the operator has enabled public sharing; the panel hides Share if not. */
  previewSharing: boolean;
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

/** The live public shares the owner has minted. */
export function listShares(): Promise<PreviewShare[]> {
  return getJson<PreviewShare[]>("/api/preview/shares");
}

/** Mint a public share for a port; the returned `url` is the link to hand out. */
export function createShare(port: number): Promise<PreviewShare> {
  return postJson<PreviewShare>("/api/preview/shares", { port });
}

/** Revoke a share by id; the link 404s immediately afterwards. */
export function revokeShare(id: string): Promise<void> {
  return del(`/api/preview/shares/${id}`);
}

/** Push a share's expiry back out to the default window. */
export function extendShare(id: string): Promise<PreviewShare> {
  return postJson<PreviewShare>(`/api/preview/shares/${id}/extend`, {});
}

/** The state of a preview port, as the panel's probe reads it. */
export type ProbeState = "ready" | "down";

/**
 * Probe a preview port by asking the proxy for it with a HEAD. The bridge marks
 * every answer it gives on the upstream's behalf — nothing listening, nothing
 * answering — with `X-Preview-Upstream: down`. Anything else came from the app
 * itself, error statuses included, and is the app's to show, so it is "ready".
 */
export async function probePreview(port: number, path: string): Promise<ProbeState> {
  const url = `${basePath()}/preview/${port}/${path.replace(/^\/+/, "")}`;
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    return res.headers.get("x-preview-upstream") === "down" ? "down" : "ready";
  } catch {
    return "down";
  }
}
