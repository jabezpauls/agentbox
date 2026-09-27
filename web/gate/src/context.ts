import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Auth, Subject } from "./auth.js";
import type { Config } from "./config.js";
import type { DeviceFlow } from "./device.js";
import type { PasswordChecker } from "./password.js";
import type { LoginLimiter, WindowLimiter } from "./ratelimit.js";
import type { Store } from "./store.js";
import { isRoutablePath, splitTarget } from "./path-guard.js";
import { underSegment } from "./routes.js";

/** What the gate established about a request before routing it. */
export interface RequestInfo {
  /** The client's address, as far as the gate trusts anyone to say. */
  ip: string;
  /** What limits count against: the address, or its /64 for IPv6. */
  key: string;
  viaProxy: boolean;
  /** The scheme the browser used, when the proxy says; `http` otherwise. */
  proto: string;
  host: string;
}

const infos = new WeakMap<IncomingMessage, RequestInfo>();

export function setInfo(req: IncomingMessage, info: RequestInfo): void {
  infos.set(req, info);
}

export function peekInfo(req: IncomingMessage): RequestInfo | undefined {
  return infos.get(req);
}

export function infoOf(req: IncomingMessage): RequestInfo {
  const info = infos.get(req);
  if (!info) throw new Error("request reached a handler without passing the dispatcher");
  return info;
}

/** Everything the gate's handlers share. */
export interface GateCore {
  config: Config;
  store: Store;
  auth: Auth;
  devices: DeviceFlow;
  /** Sign-in and every other password check. */
  limiter: LoginLimiter;
  /** Starting a device login: no bcrypt, but not free either. */
  deviceStarts: WindowLimiter;
  devicePolls: WindowLimiter;
  /** Two-factor enrolment confirmations. */
  totpConfirms: WindowLimiter;
  passwords: PasswordChecker;
  now: () => number;
  authenticate(req: IncomingMessage): Subject | null;
}

/** Compare two strings in time that does not depend on where they differ. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Where to send someone after signing in. Only a path on this box, and never
 * back into the gate's own pages: anything else — another host, a
 * protocol-relative `//evil`, a path the guard would refuse — becomes `/`.
 */
export function safeNext(raw: unknown): string {
  if (typeof raw !== "string" || raw === "" || raw.length > 2048) return "/";
  // Printable ASCII only: a browser percent-encodes everything else, and this
  // ends up in a Location header, where a raw control or non-ASCII character
  // is either an injection or an error.
  if (/[^\x21-\x7e]/.test(raw)) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  const { path } = splitTarget(raw);
  if (!isRoutablePath(path)) return "/";
  if (underSegment(path, "/login") || underSegment(path, "/_gate")) return "/";
  return raw;
}

/** The origin people browse to: configured, or this request's own. */
export function originOf(core: GateCore, req: IncomingMessage): string {
  if (core.config.publicUrl) return core.config.publicUrl;
  const info = infoOf(req);
  // A Host header is whatever the client sent; only a plausible host:port is
  // echoed into a link.
  const host = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(info.host) ? info.host : "localhost";
  return `${info.proto}://${host}`;
}
