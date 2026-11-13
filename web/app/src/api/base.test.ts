import { afterEach, describe, expect, it, vi } from "vitest";
import { apiUrl, setApiBase, wsUrl } from "./base.ts";

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

describe("setApiBase", () => {
  afterEach(() => setApiBase(""));

  it("prefixes the API, the sockets, the app registry and the apps, and nothing else", () => {
    stubLocation({ protocol: "https:", host: "machines.box" });
    setApiBase("/m/abc/");
    expect(apiUrl("/api/session")).toBe("/m/abc/api/session");
    expect(apiUrl("/api")).toBe("/m/abc/api");
    expect(apiUrl("/_gate/apps")).toBe("/m/abc/_gate/apps");
    expect(apiUrl("/_gate/apps/x/visibility")).toBe("/m/abc/_gate/apps/x/visibility");
    expect(apiUrl("/a/site/")).toBe("/m/abc/a/site/");
    expect(wsUrl("/ws/events")).toBe("wss://machines.box/m/abc/ws/events");
    expect(apiUrl("/_gate/session")).toBe("/_gate/session");
    expect(apiUrl("/apix")).toBe("/apix");
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
