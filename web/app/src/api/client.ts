import type { DirEntry, LavishState, ListeningPort, SessionSnapshot } from "@workbench/shared";
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

export function getSession(): Promise<SessionSnapshot> {
  return getJson<SessionSnapshot>("/api/session");
}

export function getPorts(): Promise<ListeningPort[]> {
  return getJson<ListeningPort[]>("/api/ports");
}

export function getLavish(): Promise<LavishState> {
  return getJson<LavishState>("/api/lavish");
}

export function listDirs(path: string): Promise<DirEntry[]> {
  return getJson<DirEntry[]>(`/api/fs/dirs?path=${encodeURIComponent(path)}`);
}
