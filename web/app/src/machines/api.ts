// The machines origin's own API (the gate's, not a machine's): the list,
// the machines session, and presence through the gate.

export interface MachineView {
  id: string;
  name: string;
  state: "online" | "offline" | "paused" | "revoked" | "left";
  reported: { platform: string; arch: string; hostname: string };
  specs: {
    version: string;
    platform: string;
    arch: string;
    hostname: string;
    cpu: { model: string; cores: number };
    ramBytes: number;
    gpus: Array<{ name: string; memoryMiB: number | null }>;
    docker: boolean;
    claude: string | null;
    policy: { terminals: boolean; presenceHours: number; problem: string | null; files: Array<{ path: string; mode: string }> };
  } | null;
  lastSeenAt: number | null;
  upgradeNeeded: boolean;
}

export class MachinesError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401 && path.startsWith("/_gate/machines/") && data.error === "unauthorized") {
    // The machines session is gone: the page load starts the sign-in again.
    location.reload();
  }
  if (!res.ok) throw new MachinesError(res.status, typeof data.message === "string" ? data.message : `${path}: ${res.status}`, typeof data.error === "string" ? data.error : null);
  return data as T;
}

export const machinesApi = {
  list: () => call<{ machines: MachineView[] }>("GET", "/_gate/machines/list").then((r) => r.machines),
  session: () => call<{ id: string }>("GET", "/_gate/machines/session"),
  presence: (id: string) => call<{ granted: boolean; expiresAt: number | null }>("GET", `/_gate/machines/m/${id}/presence`),
  challenge: (id: string) =>
    call<{ challenge: string; salt: string; iterations: number; session: string; machine: string }>("POST", `/_gate/machines/m/${id}/presence/challenge`),
  prove: (id: string, challenge: string, answer: string) => call<{ ok: true; expiresAt: number }>("POST", `/_gate/machines/m/${id}/presence`, { challenge, answer }),
  signOut: () => fetch("/signout", { method: "POST", credentials: "same-origin" }),
};
