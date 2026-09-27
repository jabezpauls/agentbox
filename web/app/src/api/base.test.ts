import { afterEach, describe, expect, it, vi } from "vitest";
import { apiUrl, wsUrl } from "./base.ts";

function stubLocation(partial: Partial<Location>): void {
  vi.stubGlobal("location", {
    pathname: "/",
    protocol: "http:",
    host: "example.com",
    ...partial,
  } as Location);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiUrl", () => {
  it("is the root path at the root", () => {
    stubLocation({ pathname: "/" });
    expect(apiUrl("/api/session")).toBe("/api/session");
  });

  it("does not follow the page's own path", () => {
    // A deep link is a client route; the API stays at the root beneath it.
    stubLocation({ pathname: "/files/src/deep" });
    expect(apiUrl("/api/session")).toBe("/api/session");
    stubLocation({ pathname: "/workbench" });
    expect(apiUrl("/api/session")).toBe("/api/session");
  });
});

describe("wsUrl", () => {
  it("uses ws over http", () => {
    stubLocation({ pathname: "/workbench", protocol: "http:", host: "box:7800" });
    expect(wsUrl("/ws/events")).toBe("ws://box:7800/ws/events");
  });

  it("uses wss over https", () => {
    stubLocation({ pathname: "/files/x", protocol: "https:", host: "box" });
    expect(wsUrl("/ws/events")).toBe("wss://box/ws/events");
  });
});
