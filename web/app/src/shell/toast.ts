import { errorText } from "../api/http.ts";
import { useApp, type ToastOpts } from "../store/app.ts";

/**
 * Toasts from anywhere in the app, in one voice: a short statement of what
 * happened, and on a failure `Couldn't <verb> <noun>.` with the server's own
 * sentence underneath.
 */
export function toast(kind: "info" | "success" | "error", title: string, detail?: string, opts?: ToastOpts): void {
  useApp.getState().pushToast({ kind, paneId: "", title, ...(detail ? { detail } : {}) }, opts);
}

/** A failure, with the reason in words and, when given, a way to try again. */
export function toastError(title: string, err: unknown, retry?: () => void): void {
  const detail = errorText(err);
  toast("error", title, detail, { ...(retry ? { retry } : {}), dedupe: `error:${title}:${detail}` });
}
