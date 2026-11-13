import type { IncomingMessage, ServerResponse } from "node:http";
import { isSafeMethod } from "../origin.js";

/**
 * The machines origin's rules for every request and response (see the design,
 * "The machines origin's rules"). The machines host and the box are usually
 * the same site, so the browser sends the machines cookie on requests that
 * script on the box's origin — which the sandbox may control — makes there.
 * So nothing but a GET or HEAD is taken without `Origin` being exactly the
 * machines origin, and no response may be framed, read cross-origin, or share
 * a browsing context group or agent cluster with the box.
 */

/** On every response from the machines origin, whatever produced it. */
export const MACHINES_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Cross-Origin-Resource-Policy", "same-origin"],
  ["X-Content-Type-Options", "nosniff"],
  ["Content-Security-Policy", "frame-ancestors 'none'"],
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Origin-Agent-Cluster", "?1"],
  ["Referrer-Policy", "no-referrer"],
  ["Cache-Control", "no-store"],
];

/**
 * Set the header set on `res` before anything answers it. Node merges these
 * into whatever writes the head later — Fastify, a refusal, an error — so no
 * path out of the gate can leave them off; a page's own fuller CSP (which
 * also says `frame-ancestors 'none'`) replaces the bare one.
 */
export function setMachinesHeaders(res: ServerResponse): void {
  for (const [n, v] of MACHINES_HEADERS) res.setHeader(n, v);
}

/** The header lines of MACHINES_HEADERS, for a refused WebSocket handshake. */
export function machinesHeaderLines(): string {
  return MACHINES_HEADERS.map(([n, v]) => `${n}: ${v}\r\n`).join("");
}

/** `https://<machines host>`: TLS always ends before the gate, and the machines cookie is `Secure`. */
export function machinesOriginOf(machinesHost: string): string {
  return `https://${machinesHost}`;
}

export interface Refusal {
  status: number;
  message: string;
}

/**
 * Why a request to the machines origin is refused before routing, or `null`.
 * `upgrade` for a WebSocket handshake, which is a GET the same-origin policy
 * does not restrain, so it is held to the rule for writes.
 */
export function machinesRequestRefusal(req: IncomingMessage, origin: string, upgrade: boolean): Refusal | null {
  if (req.headers["service-worker"] !== undefined) return { status: 403, message: "service workers are not allowed here" };
  if (!upgrade && isSafeMethod(req.method)) return null;
  if (req.headers.origin !== origin) return { status: 403, message: "request refused: it did not come from the machines page" };
  // Chromium has sent none on WebSocket handshakes; when it is there, it must agree.
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") {
    return { status: 403, message: "request refused: it did not come from the machines page" };
  }
  return null;
}
