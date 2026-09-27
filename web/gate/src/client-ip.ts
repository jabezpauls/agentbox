import dns from "node:dns/promises";
import net from "node:net";
import type { IncomingMessage } from "node:http";

/**
 * Whose address is this? Rate limits, lockouts and the session list all key on
 * it, so it must not be something a client can simply claim.
 *
 * Forwarding headers are believed only on a connection from the proxy. The
 * proxy is named in configuration (the compose service `proxy`) and resolved
 * through Docker's DNS, which nothing in the sandbox can write; a sandbox
 * container cannot forge the proxy's source address either, having no
 * NET_RAW or NET_ADMIN. Anyone else — including an agent calling the gate
 * directly — is judged by the address it connects from.
 *
 * On a proxy connection the address comes from `AGENTBOX_CLIENT_IP_HEADER`
 * when set (traefik mode sets `CF-Connecting-IP`), otherwise from the last
 * entry of `X-Forwarded-For`: Caddy replaces a client's own copy of that header
 * with the address it saw, or — trusting nothing upstream by default — appends
 * that address last.
 */

/** `::ffff:10.0.0.1` and `10.0.0.1` are the same client. */
export function normalizeIp(ip: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return (v4 ? v4[1] : ip) as string;
}

const RESOLVE_TTL_MS = 30_000;
const RETRY_MS = 2_000;

type Lookup = (host: string) => Promise<string[]>;

const defaultLookup: Lookup = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);

export interface ClientAddress {
  ip: string;
  /** True when the connection came from the trusted proxy. */
  viaProxy: boolean;
}

export class ClientIpResolver {
  private cache: { until: number; ips: Set<string> } | null = null;
  private pending: Promise<Set<string>> | null = null;

  constructor(
    private readonly trusted: string[],
    private readonly header: string | null,
    private readonly lookup: Lookup = defaultLookup,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(req: IncomingMessage): Promise<ClientAddress> {
    const peer = normalizeIp(req.socket.remoteAddress ?? "");
    if (this.trusted.length === 0 || !(await this.proxyAddresses()).has(peer)) {
      return { ip: peer, viaProxy: false };
    }
    const claimed = this.fromHeaders(req);
    return { ip: claimed ?? peer, viaProxy: true };
  }

  private fromHeaders(req: IncomingMessage): string | null {
    const name = this.header ?? "x-forwarded-for";
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw.join(",") : raw;
    if (!value) return null;
    const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
    // X-Forwarded-For grows to the right, and only its last entry was written
    // by the proxy; a named single-address header is taken as it stands.
    const pick = name === "x-forwarded-for" ? parts[parts.length - 1] : parts[0];
    if (!pick) return null;
    const ip = normalizeIp(pick);
    return net.isIP(ip) ? ip : null;
  }

  private async proxyAddresses(): Promise<Set<string>> {
    if (this.cache && this.now() < this.cache.until) return this.cache.ips;
    this.pending ??= this.refresh().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async refresh(): Promise<Set<string>> {
    const ips = new Set<string>();
    let failed = false;
    for (const entry of this.trusted) {
      if (net.isIP(entry)) {
        ips.add(normalizeIp(entry));
        continue;
      }
      try {
        for (const ip of await this.lookup(entry)) ips.add(normalizeIp(ip));
      } catch {
        // The proxy is not up (yet). Trust nothing rather than everything; its
        // requests are keyed on its own address until it resolves, so look
        // again soon.
        failed = true;
      }
    }
    this.cache = { until: this.now() + (failed ? RETRY_MS : RESOLVE_TTL_MS), ips };
    return ips;
  }
}
