import type { App } from "@workbench/shared";

/**
 * The gate's sandbox-side app API (:7901), as the bridge calls it. The records
 * are the gate's: it decides who may open an app, so the bridge only asks
 * for them, and changes what the sandbox may change — never visibility.
 */

export class GateError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : `gate answered ${status}`);
  }
}

export interface WatchResult {
  revision: number;
  /** The owner may make apps public. */
  sharing: boolean;
}

/** What the sandbox may set on an app. */
export interface AppFields {
  port?: number;
  name?: string;
  cwd?: string | null;
  command?: string | null;
  pinned?: boolean;
  keepPrefix?: boolean;
  compat?: "auto" | "off";
}

export interface GateApps {
  list(): Promise<App[]>;
  get(id: string): Promise<App | null>;
  create(fields: AppFields): Promise<App>;
  update(id: string, fields: AppFields): Promise<App>;
  remove(id: string): Promise<boolean>;
  /** Wait (up to `waitMs`) for a revision after `since`. */
  watch(since: number, waitMs: number, signal?: AbortSignal): Promise<WatchResult>;
}

export function gateApps(base: string): GateApps {
  const root = base.replace(/\/+$/, "");
  async function call<T>(method: string, path: string, body?: unknown, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ status: number; data: T }> {
    let res: Response;
    try {
      res = await fetch(`${root}${path}`, {
        method,
        headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        body: body === undefined ? null : JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      if ((err as Error).name === "AbortError" && opts.signal?.aborted) throw err;
      throw new GateError(502, { error: "gate_unreachable", message: `the gate's app API is not answering (${root})` });
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text.slice(0, 200) };
    }
    if (!res.ok && res.status !== 404) throw new GateError(res.status, (data ?? {}) as Record<string, unknown>);
    return { status: res.status, data: data as T };
  }
  const notFound = (status: number, data: unknown): void => {
    if (status === 404) throw new GateError(404, (data ?? { error: "no such app" }) as Record<string, unknown>);
  };
  return {
    async list() {
      const { status, data } = await call<App[]>("GET", "/apps");
      notFound(status, data);
      return data;
    },
    async get(id) {
      const { status, data } = await call<App>("GET", `/apps/${encodeURIComponent(id)}`);
      return status === 404 ? null : data;
    },
    async create(fields) {
      const { status, data } = await call<App>("POST", "/apps", fields);
      notFound(status, data);
      return data;
    },
    async update(id, fields) {
      const { status, data } = await call<App>("PATCH", `/apps/${encodeURIComponent(id)}`, fields);
      notFound(status, data);
      return data;
    },
    async remove(id) {
      const { status } = await call("DELETE", `/apps/${encodeURIComponent(id)}`);
      return status !== 404;
    },
    async watch(since, waitMs, signal) {
      const { data } = await call<WatchResult>("GET", `/apps/watch?since=${since}&wait=${waitMs}`, undefined, {
        ...(signal ? { signal } : {}),
        timeoutMs: waitMs + 10_000,
      });
      return data;
    },
  };
}
