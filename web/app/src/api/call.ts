import { useApp } from "../store/app.ts";
import { rpc } from "./client.ts";

/**
 * Call herdr through the bridge and surface failures instead of swallowing
 * them. Every UI call site uses this: a refused `worktree.create`, a 403 from
 * the allowlist or a herdr error now raises a toast saying which method failed
 * and why, rather than looking like a key that did nothing.
 *
 * Resolves to `undefined` on failure, so callers stay `void`-shaped and never
 * need their own catch.
 */
export function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
  return rpc<T>(method, params).catch((err: unknown) => {
    // The retry re-runs the same call, so an error toast offers a way out
    // rather than only a sentence about what went wrong.
    useApp.getState().reportRpcError(method, err, () => void call(method, params));
    return undefined;
  });
}

/** The standard action context: the app store plus the toasting caller. */
export const actionCtx = () => ({ store: useApp, rpc: call });
