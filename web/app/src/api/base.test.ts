import { afterEach, describe, expect, it, vi } from "vitest";
import { apiUrl, basePath, wsUrl } from "./base.ts";

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

describe("basePath", () => {
  it("takes the first path segment as the base", () => {
    stubLocation({ pathname: "/workbench/" });
    expect(basePath()).toBe("/workbench");
  });

  it("ignores everything past the first segment", () => {
    stubLocation({ pathname: "/workbench/x/y" });
    expect(basePath()).toBe("/workbench");
  });

  it("is empty at the root", () => {
    stubLocation({ pathname: "/" });
    expect(basePath()).toBe("");
  });
});

describe("apiUrl", () => {
  it("prefixes the base path", () => {
    stubLocation({ pathname: "/workbench/panes" });
    expect(apiUrl("/api/session")).toBe("/workbench/api/session");
  });

  it("needs no prefix at the root", () => {
    stubLocation({ pathname: "/" });
    expect(apiUrl("/api/session")).toBe("/api/session");
  });
});

describe("wsUrl", () => {
  it("uses ws over http", () => {
    stubLocation({ pathname: "/workbench/", protocol: "http:", host: "box:7800" });
    expect(wsUrl("/ws/events")).toBe("ws://box:7800/workbench/ws/events");
  });

  it("uses wss over https", () => {
    stubLocation({ pathname: "/workbench/", protocol: "https:", host: "box" });
    expect(wsUrl("/ws/events")).toBe("wss://box/workbench/ws/events");
  });
});
