import dns from "node:dns/promises";
import net from "node:net";
import type { IncomingMessage } from "node:http";

/**
 * Whose address is this? Rate limits, lockouts and the session list all key on
 * it, so it must not be something a client can simply claim.
 *
 * Deciding it is the proxy's job, because only the proxy knows who it trusts
 * in front of itself: Caddy works the client address out from its own
 * `trusted_proxies` (nobody in standalone mode; the host's proxy or Traefik,
 * plus Cloudflare's published ranges when the box is behind Cloudflare), walks
 * `X-Forwarded-For` from the right, and writes the answer into
 * `X-Agentbox-Client-IP`, replacing any copy a client sent (see
 * proxy/Caddyfile.* and proxy/trust/).
 *
 * The gate believes that header only on a connection from the proxy — named in
 * configuration, resolved in the background, never on the request path. The
 * proxy shares a network with the gate alone, so nothing in the sandbox can
 * send through it, and a sandbox container cannot forge the proxy's source
 * address (no NET_RAW). If the header is missing, the last `X-Forwarded-For`
 * entry — the hop Caddy appended itself — is used, never the leftmost. Anyone
 * else, an agent calling the gate directly included, is judged by the address
 * it connects from.
 */

export const CLIENT_IP_HEADER = "x-agentbox-client-ip";

/** `::ffff:10.0.0.1` and `10.0.0.1` are the same client. */
export function normalizeIp(ip: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return (v4 ? v4[1] : ip) as string;
}

/** The eight 16-bit groups of an IPv6 address, or `null`. */
function ipv6Groups(ip: string): number[] | null {
  if (net.isIPv6(ip) === false) return null;
  const [head = "", tail = ""] = ip.split("::");
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  let left = parse(head);
  let right = ip.includes("::") ? parse(tail) : [];
  // A trailing embedded IPv4 (::ffff:1.2.3.4) is two groups.
  const embed = (list: string[]) => {
    const last = list[list.length - 1];
    if (last && last.includes(".")) {
      const o = last.split(".").map(Number) as [number, number, number, number];
      return [...list.slice(0, -1), ((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
    }
    return list;
  };
  if (ip.includes("::")) right = embed(right);
  else left = embed(left);
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * What limits count against. One IPv4 address is one client; an IPv6 client is
 * routinely handed a whole /64, and would otherwise get a fresh budget for
 * every address in it.
 */
export function limitKey(ip: string): string {
  const groups = ipv6Groups(ip);
  if (!groups) return ip;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

const REFRESH_MS = 30_000;
const RETRY_MS = 2_000;

type Lookup = (host: string) => Promise<string[]>;

/** Both address families through the DNS resolver (c-ares), not the thread pool bcrypt uses. */
const defaultLookup: Lookup = async (host) => {
  const [v4, v6] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
  const ips = [...(v4.status === "fulfilled" ? v4.value : []), ...(v6.status === "fulfilled" ? v6.value : [])];
  if (ips.length === 0) throw new Error(`cannot resolve ${host}`);
  return ips;
};

export interface ClientAddress {
  ip: string;
  /** True when the connection came from the trusted proxy. */
  viaProxy: boolean;
}

export class ClientIpResolver {
  private trusted = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly proxies: string[],
    private readonly lookup: Lookup = defaultLookup,
    private readonly now: () => number = Date.now,
  ) {
    for (const p of proxies) if (net.isIP(p)) this.trusted.add(normalizeIp(p));
  }

  /** Resolve the proxy's name now and keep it fresh in the background. */
  async start(): Promise<void> {
    await this.refresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * Synchronous: it only ever reads the last addresses resolved. A peer it
   * does not know may be the proxy with a new address (its container was
   * recreated), so that prompts a refresh in the background — at most every
   * couple of seconds, and never waited for.
   */
  resolve(req: IncomingMessage): ClientAddress {
    const peer = normalizeIp(req.socket.remoteAddress ?? "");
    if (!this.trusted.has(peer)) {
      this.refreshSoon();
      return { ip: peer, viaProxy: false };
    }
    return { ip: fromProxy(req) ?? peer, viaProxy: true };
  }

  private refreshing = false;
  private lastRefresh = 0;

  private refreshSoon(): void {
    if (this.stopped || this.refreshing || this.proxies.every((p) => net.isIP(p))) return;
    if (this.now() - this.lastRefresh < RETRY_MS) return;
    if (this.timer) clearTimeout(this.timer);
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.refreshing = true;
    this.lastRefresh = this.now();
    try {
      await this.resolveAll();
    } finally {
      this.refreshing = false;
    }
  }

  private async resolveAll(): Promise<void> {
    const next = new Set<string>();
    let failed = false;
    for (const entry of this.proxies) {
      if (net.isIP(entry)) {
        next.add(normalizeIp(entry));
        continue;
      }
      try {
        for (const ip of await this.lookup(entry)) next.add(normalizeIp(ip));
      } catch {
        // The proxy is not up yet: keep what was known (nothing, at first).
        // Its requests are keyed on its own address until it resolves.
        failed = true;
        for (const ip of this.trusted) next.add(ip);
      }
    }
    this.trusted = next;
    if (this.stopped || this.proxies.every((p) => net.isIP(p))) return;
    this.timer = setTimeout(() => void this.refresh(), failed ? RETRY_MS : REFRESH_MS);
    this.timer.unref?.();
  }
}

/** The client address the proxy reported, if it is an address at all. */
function fromProxy(req: IncomingMessage): string | null {
  const stated = req.headers[CLIENT_IP_HEADER];
  const one = Array.isArray(stated) ? stated[stated.length - 1] : stated;
  const candidate = one?.trim() || lastForwardedFor(req);
  if (!candidate) return null;
  const ip = normalizeIp(candidate);
  return net.isIP(ip) ? ip : null;
}

/** The last X-Forwarded-For entry: the one the proxy appended. */
function lastForwardedFor(req: IncomingMessage): string | null {
  const raw = req.headers["x-forwarded-for"];
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  if (!value) return null;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts[parts.length - 1] ?? null;
}
