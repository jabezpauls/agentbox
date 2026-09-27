import { ApiError, CliError, EXIT } from "./errors.js";
import type { BoxClient } from "./http.js";

/**
 * The device flow, client side (RFC 8628 in shape; the gate's device.ts is
 * the other half). The CLI never sees the password: it asks for a code, the
 * owner approves it in a signed-in browser, and the CLI collects a token.
 */

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  /** Seconds between polls. */
  interval: number;
  /** Seconds until the code lapses. */
  expiresIn: number;
}

export const TOKEN_SHAPE = /^abx_[A-Za-z0-9_-]{43}$/;

export async function startDeviceLogin(client: BoxClient, name: string): Promise<DeviceStart> {
  let res: Partial<DeviceStart>;
  try {
    res = await client.json<Partial<DeviceStart>>("POST", "/_gate/device/start", {
      auth: false,
      body: { json: { name } },
      what: "starting the sign-in",
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new CliError(`${client.origin} does not offer device sign-in; is it an agentbox, and up to date?`, EXIT.NOT_FOUND);
    }
    if (err instanceof ApiError && err.status === 429) {
      throw new CliError(`the box is refusing new sign-ins for a moment (${err.message}); try again in a minute`);
    }
    throw err;
  }
  if (
    typeof res?.deviceCode !== "string" ||
    typeof res.userCode !== "string" ||
    typeof res.verifyUrl !== "string" ||
    typeof res.interval !== "number" ||
    typeof res.expiresIn !== "number"
  ) {
    throw new CliError(`${client.origin} answered the sign-in in a shape this CLI does not know; is it an agentbox?`);
  }
  return res as DeviceStart;
}

export interface PollDeps {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  /** Network failures tolerated in a row before giving up. */
  maxNetworkErrors?: number;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CliError("interrupted", EXIT.INTERRUPTED));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new CliError("interrupted", EXIT.INTERRUPTED));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll until the owner approves (the token), denies, or the code lapses.
 * Follows the RFC's answers: `authorization_pending` waits, `slow_down`
 * waits five seconds longer from then on. A network blip is retried rather
 * than thrown away with the code the owner may be approving right now.
 */
export async function pollForToken(client: BoxClient, start: DeviceStart, deps: PollDeps = {}): Promise<string> {
  const wait = deps.sleep ?? sleep;
  const now = deps.now ?? Date.now;
  const deadline = now() + start.expiresIn * 1000;
  let interval = Math.max(1, start.interval) * 1000;
  let networkErrors = 0;

  for (;;) {
    await wait(interval, deps.signal);
    if (now() > deadline) throw new CliError("the code expired before it was approved; run `agentbox login` again");

    let status: number;
    let body: { token?: unknown; error?: unknown };
    let retryAfter: string | undefined;
    try {
      const res = await client.request("POST", "/_gate/device/poll", {
        auth: false,
        body: { json: { deviceCode: start.deviceCode } },
        headers: { accept: "application/json" },
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      status = res.status;
      retryAfter = typeof res.headers["retry-after"] === "string" ? res.headers["retry-after"] : undefined;
      const text = await res.text();
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        body = {};
      }
      networkErrors = 0;
    } catch (err) {
      if (err instanceof CliError && err.exitCode === EXIT.UNREACHABLE && ++networkErrors <= (deps.maxNetworkErrors ?? 5)) continue;
      throw err;
    }

    if (status === 200) {
      if (typeof body.token === "string" && TOKEN_SHAPE.test(body.token)) return body.token;
      throw new CliError("the box answered with something that is not a device token");
    }
    if (status === 429) {
      const s = Number(retryAfter);
      if (Number.isFinite(s) && s > 0) await wait(s * 1000, deps.signal);
      continue;
    }
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5000;
        continue;
      case "access_denied":
        throw new CliError("the sign-in was denied on the box");
      case "expired_token":
        throw new CliError("the code expired, or was already used; run `agentbox login` again");
      default:
        throw new CliError(`the box refused the sign-in (HTTP ${status}${typeof body.error === "string" ? `: ${body.error}` : ""})`);
    }
  }
}

/**
 * The approval page to open. The box names it, and behind a proxy it may name
 * its public origin rather than the one typed here, which is fine; but what
 * gets handed to the browser is only ever an http(s) URL of the approval
 * page, else the same page on the origin that was typed.
 */
export function safeVerifyUrl(verifyUrl: string, origin: string, userCode: string): string {
  const fallback = `${origin}/settings/devices?code=${encodeURIComponent(userCode)}`;
  try {
    const url = new URL(verifyUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return fallback;
    if (url.pathname !== "/settings/devices" || url.username || url.password) return fallback;
    return url.href;
  } catch {
    return fallback;
  }
}
