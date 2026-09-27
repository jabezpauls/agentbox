/**
 * JSON over fetch for the app's own APIs — the bridge's `/api/*` and the
 * gate's `/_gate/*`. Every failure is an {@link HttpError} carrying the
 * server's own sentence, so a toast can say what went wrong in words rather
 * than a status code.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The machine-readable reason, when the server gives one (`exists`, `password_required`). */
    readonly code: string | undefined,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** The human part of an error: the server's message, or a calm fallback. */
export function errorText(err: unknown, fallback = "Something went wrong on the way."): string {
  if (err instanceof HttpError) return err.message || fallback;
  if (err instanceof Error && err.name === "AbortError") return "Cancelled.";
  if (err instanceof TypeError) return "The box could not be reached. Check the connection and try again.";
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method, headers: { accept: "application/json" } };
  if (body !== undefined) {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  if (signal) init.signal = signal;
  const res = await fetch(path, init);
  const data = await parse(res);
  if (!res.ok) {
    const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const message =
      (typeof obj.message === "string" && obj.message) ||
      (typeof obj.error === "string" && obj.error.includes(" ") && obj.error) ||
      statusText(res.status);
    const code = typeof obj.code === "string" ? obj.code : typeof obj.error === "string" && !obj.error.includes(" ") ? obj.error : undefined;
    throw new HttpError(res.status, message, code, obj);
  }
  return data as T;
}

function statusText(status: number): string {
  if (status === 404) return "It is not there any more.";
  if (status === 403) return "That was refused.";
  if (status === 409) return "That clashes with something already there.";
  if (status === 413) return "That is too large.";
  if (status === 429) return "Too many attempts. Wait a moment and try again.";
  if (status >= 500) return "The box ran into a problem. Try again in a moment.";
  return "That did not work.";
}

export const http = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  del: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),
};
