import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { ClientIpResolver, normalizeIp } from "../src/client-ip.js";

function req(peer: string, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress: peer }, headers } as unknown as IncomingMessage;
}

describe("the client address", () => {
  it("is the peer when no proxy is trusted, whatever the headers claim", async () => {
    const r = new ClientIpResolver([], null);
    expect(await r.resolve(req("10.0.0.5", { "x-forwarded-for": "1.2.3.4" }))).toEqual({ ip: "10.0.0.5", viaProxy: false });
  });

  it("is the peer for anyone but the proxy — the sandbox included", async () => {
    const r = new ClientIpResolver(["proxy"], null, async () => ["172.20.0.2"]);
    const sandbox = req("172.20.0.3", { "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "5.6.7.8" });
    expect(await r.resolve(sandbox)).toEqual({ ip: "172.20.0.3", viaProxy: false });
  });

  it("takes the last X-Forwarded-For entry from the proxy — the one the proxy wrote", async () => {
    const r = new ClientIpResolver(["proxy"], null, async () => ["172.20.0.2"]);
    const viaProxy = req("::ffff:172.20.0.2", { "x-forwarded-for": "6.6.6.6, 203.0.113.9" });
    expect(await r.resolve(viaProxy)).toEqual({ ip: "203.0.113.9", viaProxy: true });
  });

  it("takes the configured header from the proxy when one is set", async () => {
    const r = new ClientIpResolver(["172.20.0.2"], "cf-connecting-ip");
    expect(await r.resolve(req("172.20.0.2", { "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "1.1.1.1" }))).toEqual({
      ip: "198.51.100.7",
      viaProxy: true,
    });
  });

  it("falls back to the peer when the proxy's header is missing or not an address", async () => {
    const r = new ClientIpResolver(["172.20.0.2"], "cf-connecting-ip");
    expect((await r.resolve(req("172.20.0.2"))).ip).toBe("172.20.0.2");
    expect((await r.resolve(req("172.20.0.2", { "cf-connecting-ip": "not-an-ip" }))).ip).toBe("172.20.0.2");
  });

  it("trusts nothing while the proxy's name does not resolve, and looks again soon", async () => {
    let t = 0;
    let up = false;
    const r = new ClientIpResolver(
      ["proxy"],
      null,
      async () => {
        if (!up) throw new Error("ENOTFOUND");
        return ["172.20.0.2"];
      },
      () => t,
    );
    const viaProxy = req("172.20.0.2", { "x-forwarded-for": "203.0.113.9" });
    expect((await r.resolve(viaProxy)).viaProxy).toBe(false);
    up = true;
    t += 2_000;
    expect(await r.resolve(viaProxy)).toEqual({ ip: "203.0.113.9", viaProxy: true });
  });

  it("normalises IPv4-mapped IPv6", () => {
    expect(normalizeIp("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(normalizeIp("::1")).toBe("::1");
  });
});
