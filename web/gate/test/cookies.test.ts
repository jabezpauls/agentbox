import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { isOurCookie, readCookie, sessionCookie, setsOurCookie, stripOurCookies } from "../src/cookies.js";
import { forwardRequestHeaders } from "../src/proxy.js";
import { isSameOriginRequest, originMatchesHost } from "../src/origin.js";
import { safeNext } from "../src/context.js";

describe("the gate's cookies", () => {
  it("are recognised whatever their case", () => {
    expect(isOurCookie("__Host-agentbox")).toBe(true);
    expect(isOurCookie("__host-AGENTBOX")).toBe(true);
    expect(isOurCookie("__Secure-agentbox-app")).toBe(true);
    expect(isOurCookie(" __secure-agentbox-app ")).toBe(true);
    expect(isOurCookie("agentbox")).toBe(false);
    expect(isOurCookie("__Host-agentbox2")).toBe(false);
  });

  it("are stripped from a Cookie header, leaving the rest in order", () => {
    expect(stripOurCookies("a=1; __Host-agentbox=s3cret; b=2; __Secure-agentbox-app=g; __host-agentbox=x")).toBe("a=1; b=2");
    expect(stripOurCookies("__Host-agentbox=only")).toBeUndefined();
    expect(stripOurCookies(undefined)).toBeUndefined();
  });

  it("can be read", () => {
    expect(readCookie("x=1; __Host-agentbox=abc; y=2", "__Host-agentbox")).toBe("abc");
    expect(readCookie("x=1", "__Host-agentbox")).toBeNull();
  });

  it("cannot be set by an upstream", () => {
    expect(setsOurCookie("__Host-agentbox=evil; Path=/; Secure")).toBe(true);
    expect(setsOurCookie("__HOST-agentbox=evil")).toBe(true);
    expect(setsOurCookie("vscode-tkn=1; Path=/")).toBe(false);
  });

  it("the session cookie is host-only, secure, http-only and lax", () => {
    const c = sessionCookie("abc", null);
    expect(c).toBe("__Host-agentbox=abc; Path=/; HttpOnly; Secure; SameSite=Lax");
    expect(sessionCookie("abc", 60)).toContain("Max-Age=60");
    expect(c).not.toMatch(/domain/i);
  });
});

describe("the headers forwarded upstream", () => {
  const fwd = { clientIp: "203.0.113.9", proto: "https", host: "box.example" };
  const from = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

  it("carry no credential and no identity claim of the client's", () => {
    const out = forwardRequestHeaders(
      from({
        host: "box.example",
        authorization: "Basic b3duZXI6cGFzc3dvcmQ=",
        "proxy-authorization": "Basic eA==",
        cookie: "__Host-agentbox=s; app=1",
        "x-forwarded-for": "6.6.6.6",
        "x-forwarded-host": "evil.example",
        forwarded: "for=6.6.6.6",
        "x-agentbox-public": "1",
        accept: "text/html",
        connection: "keep-alive, x-secret",
        "x-secret": "hop",
      }),
      fwd,
    );
    expect(out.authorization).toBeUndefined();
    expect(out["proxy-authorization"]).toBeUndefined();
    expect(out.cookie).toBe("app=1");
    expect(out.forwarded).toBeUndefined();
    expect(out["x-agentbox-public"]).toBeUndefined();
    expect(out["x-secret"]).toBeUndefined();
    expect(out.connection).toBeUndefined();
    expect(out["x-forwarded-for"]).toBe("203.0.113.9");
    expect(out["x-forwarded-host"]).toBe("box.example");
    expect(out["x-forwarded-proto"]).toBe("https");
    expect(out.host).toBe("box.example");
    expect(out.accept).toBe("text/html");
  });

  it("drop the Cookie header entirely when only ours were in it", () => {
    const out = forwardRequestHeaders(from({ cookie: "__Host-agentbox=s" }), fwd);
    expect(out.cookie).toBeUndefined();
  });

  it("keep the upgrade handshake for a WebSocket", () => {
    const out = forwardRequestHeaders(from({ connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "k" }), fwd, true);
    expect(out.connection).toBe("Upgrade");
    expect(out.upgrade).toBe("websocket");
    expect(out["sec-websocket-key"]).toBe("k");
  });
});

describe("same-origin checks", () => {
  it("compare the Origin's host with Host", () => {
    expect(originMatchesHost({ origin: "https://box.example", host: "box.example" })).toBe(true);
    expect(originMatchesHost({ origin: "http://box.example", host: "BOX.example" })).toBe(true);
    expect(originMatchesHost({ origin: "https://evil.example", host: "box.example" })).toBe(false);
    expect(originMatchesHost({ origin: "https://box.example:8443", host: "box.example" })).toBe(false);
    expect(originMatchesHost({ origin: "null", host: "box.example" })).toBe(false);
    expect(originMatchesHost({ origin: "file://box.example", host: "box.example" })).toBe(false);
    expect(originMatchesHost({ host: "box.example" })).toBe(false);
  });

  it("accept Sec-Fetch-Site: same-origin only when there is no Origin at all", () => {
    expect(isSameOriginRequest({ host: "b", "sec-fetch-site": "same-origin" })).toBe(true);
    expect(isSameOriginRequest({ host: "b", origin: "https://evil", "sec-fetch-site": "same-origin" })).toBe(false);
    expect(isSameOriginRequest({ host: "b", "sec-fetch-site": "same-site" })).toBe(false);
    expect(isSameOriginRequest({ host: "b" })).toBe(false);
  });
});

describe("where sign-in sends you next", () => {
  it("is only ever a path on this box, outside the gate's own pages", () => {
    expect(safeNext("/workbench/?review=abc")).toBe("/workbench/?review=abc");
    expect(safeNext("/vscode/")).toBe("/vscode/");
    for (const bad of ["//evil.example/", "/\\evil.example", "https://evil.example/", "evil", "/a/../b", "/login", "/login?next=/x", "/_gate/logout", "/a\nb", "/€", "/é", "", undefined, 3]) {
      expect(safeNext(bad), String(bad)).toBe("/");
    }
  });
});
