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
    useApp.getState().reportRpcError(method, err);
    return undefined;
  });
}

/** The standard action context: the app store plus the toasting caller. */
export const actionCtx = () => ({ store: useApp, rpc: call });
