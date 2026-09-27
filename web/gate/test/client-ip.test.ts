import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { ClientIpResolver, limitKey, normalizeIp } from "../src/client-ip.js";

function req(peer: string, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress: peer }, headers } as unknown as IncomingMessage;
}

async function resolver(proxies: string[], lookup?: (h: string) => Promise<string[]>) {
  const r = new ClientIpResolver(proxies, lookup);
  await r.start();
  return r;
}

describe("the client address", () => {
  it("is the peer when no proxy is trusted, whatever the headers claim", async () => {
    const r = await resolver([]);
    const claims = { "x-forwarded-for": "1.2.3.4", "x-agentbox-client-ip": "5.6.7.8", "cf-connecting-ip": "9.9.9.9" };
    expect(r.resolve(req("10.0.0.5", claims))).toEqual({ ip: "10.0.0.5", viaProxy: false });
  });

  it("is the peer for anyone but the proxy — the sandbox included", async () => {
    const r = await resolver(["proxy"], async () => ["172.20.0.2"]);
    const sandbox = req("172.20.0.3", { "x-agentbox-client-ip": "1.2.3.4", "x-forwarded-for": "1.2.3.4" });
    expect(r.resolve(sandbox)).toEqual({ ip: "172.20.0.3", viaProxy: false });
  });

  it("takes the address the proxy computed, in its own header", async () => {
    const r = await resolver(["proxy"], async () => ["172.20.0.2"]);
    const viaProxy = req("::ffff:172.20.0.2", { "x-agentbox-client-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6, 198.51.100.1" });
    expect(r.resolve(viaProxy)).toEqual({ ip: "203.0.113.9", viaProxy: true });
  });

  it("without that header, takes the last X-Forwarded-For hop — the one the proxy appended — never the first", async () => {
    const r = await resolver(["172.20.0.2"]);
    expect(r.resolve(req("172.20.0.2", { "x-forwarded-for": "6.6.6.6, 203.0.113.9" })).ip).toBe("203.0.113.9");
  });

  it("ignores any other header, CF-Connecting-IP included", async () => {
    const r = await resolver(["172.20.0.2"]);
    expect(r.resolve(req("172.20.0.2", { "cf-connecting-ip": "198.51.100.7" })).ip).toBe("172.20.0.2");
  });

  it("falls back to the peer when the proxy states something that is not an address", async () => {
    const r = await resolver(["172.20.0.2"]);
    expect(r.resolve(req("172.20.0.2", { "x-agentbox-client-ip": "not-an-ip" })).ip).toBe("172.20.0.2");
  });

  it("never looks anything up while answering: resolving is synchronous, from what was last resolved", async () => {
    let calls = 0;
    const r = await resolver(["proxy"], async () => {
      calls++;
      return ["172.20.0.2"];
    });
    const out = r.resolve(req("172.20.0.2", { "x-agentbox-client-ip": "203.0.113.9" }));
    expect(out).not.toBeInstanceOf(Promise);
    expect(out.ip).toBe("203.0.113.9");
    r.resolve(req("172.20.0.2"));
    expect(calls).toBe(1);
    r.stop();
  });

  it("trusts nothing until the proxy's name resolves, then trusts it", async () => {
    let up = false;
    const r = new ClientIpResolver(["proxy"], async () => {
      if (!up) throw new Error("ENOTFOUND");
      return ["172.20.0.2"];
    });
    await r.start();
    const viaProxy = req("172.20.0.2", { "x-agentbox-client-ip": "203.0.113.9" });
    expect(r.resolve(viaProxy).viaProxy).toBe(false);
    up = true;
    await r.start();
    expect(r.resolve(viaProxy)).toEqual({ ip: "203.0.113.9", viaProxy: true });
    r.stop();
  });

  it("looks again, in the background, when an unknown peer appears — the proxy may have a new address", async () => {
    let address = "172.20.0.2";
    let calls = 0;
    let t = 1_000_000;
    const r = new ClientIpResolver(
      ["proxy"],
      async () => {
        calls++;
        return [address];
      },
      () => t,
    );
    await r.start();
    // Some seconds on, the proxy's container is recreated with a new address.
    t += 5_000;
    address = "172.20.0.9";
    const moved = req("172.20.0.9", { "x-agentbox-client-ip": "203.0.113.9" });
    // This request is not believed — and is not held up by the lookup...
    expect(r.resolve(moved).viaProxy).toBe(false);
    await new Promise((res) => setTimeout(res, 10));
    // ...but the next one is, without waiting out the half-minute refresh.
    expect(r.resolve(moved)).toEqual({ ip: "203.0.113.9", viaProxy: true });
    // A stream of strangers does not become a stream of lookups.
    for (let i = 0; i < 20; i++) r.resolve(req(`10.0.0.${i}`));
    expect(calls).toBe(2);
    r.stop();
  });

  it("normalises IPv4-mapped IPv6", () => {
    expect(normalizeIp("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(normalizeIp("::1")).toBe("::1");
  });
});

describe("what limits count against", () => {
  it("is the address for IPv4, and the /64 for IPv6", () => {
    expect(limitKey("203.0.113.9")).toBe("203.0.113.9");
    expect(limitKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(limitKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(limitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(limitKey("::1")).toBe("0:0:0:0::/64");
    expect(limitKey("2001:0db8:0001:0002::ffff:1.2.3.4")).toBe("2001:db8:1:2::/64");
  });

  it("puts every address of one /64 in one budget", () => {
    const a = limitKey("2001:db8:5:6::1");
    const b = limitKey("2001:db8:5:6:dead:beef:0:9");
    const other = limitKey("2001:db8:5:7::1");
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });
});
