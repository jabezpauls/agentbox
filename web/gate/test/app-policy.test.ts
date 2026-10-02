import { describe, expect, it } from "vitest";
import {
  APP_PERMISSIONS,
  APP_SANDBOX,
  appOriginAllowed,
  appResponseHeaders,
  editableType,
  isFontType,
  isNullPreflight,
  preflightHeaders,
  rewriteLocation,
  rewriteSetCookie,
} from "../src/app-policy.js";

const P = "/a/abcdefghijklmnopqrstuvwxyz";

describe("an app's cookies", () => {
  it("are scoped to the app and sent from its opaque origin", () => {
    expect(rewriteSetCookie("sid=abc; Path=/; Domain=localhost; HttpOnly; SameSite=Lax", P)).toBe(`sid=abc; Path=${P}/; HttpOnly; Secure; SameSite=None`);
    expect(rewriteSetCookie("t=1; path=/api; secure; samesite=strict; Max-Age=60", P)).toBe(`t=1; Path=${P}/api; Max-Age=60; Secure; SameSite=None`);
    // A path the app already knows is its own (started with its base path) stays.
    expect(rewriteSetCookie(`k=v; Path=${P}/x`, P)).toBe(`k=v; Path=${P}/x; Secure; SameSite=None`);
    // No Path: the browser's default is the request's directory, already under the app.
    expect(rewriteSetCookie("k=v", P)).toBe("k=v; Secure; SameSite=None");
  });
});

describe("an app's redirects", () => {
  it("stay inside the app", () => {
    expect(rewriteLocation("/dashboard", P, 5173)).toBe(`${P}/dashboard`);
    expect(rewriteLocation("http://localhost:5173/x?y=1", P, 5173)).toBe(`${P}/x?y=1`);
    expect(rewriteLocation("http://127.0.0.1:5173", P, 5173)).toBe(`${P}/`);
    expect(rewriteLocation(`${P}/already`, P, 5173)).toBe(`${P}/already`);
  });

  it("leave another site, another port and relative paths alone", () => {
    for (const v of ["https://github.com/login", "http://localhost:9999/x", "next", "../up", "//cdn.example/x"]) {
      expect(rewriteLocation(v, P, 5173), v).toBe(v);
    }
  });
});

describe("the response policy", () => {
  const ctx = { prefix: P, port: 5173, origin: undefined };

  it("always sandboxes, and drops what an app may not send", () => {
    const out = appResponseHeaders(
      [
        ["Content-Type", "text/html"],
        ["Content-Security-Policy", "default-src 'self'"],
        ["Clear-Site-Data", '"*"'],
        ["Strict-Transport-Security", "max-age=1"],
        ["Service-Worker-Allowed", "/"],
        ["Set-Cookie", "__Host-agentbox=x; Path=/"],
        ["Set-Cookie", "app=1; Path=/"],
      ],
      ctx,
    );
    const names = out.map(([n]) => n.toLowerCase());
    expect(names).not.toContain("clear-site-data");
    expect(names).not.toContain("strict-transport-security");
    expect(names).not.toContain("service-worker-allowed");
    expect(out.filter(([n]) => n === "Set-Cookie")).toEqual([["Set-Cookie", `app=1; Path=${P}/; Secure; SameSite=None`]]);
    // The app's own policy stays, and the sandbox is added beside it.
    expect(out.filter(([n]) => n.toLowerCase() === "content-security-policy").map(([, v]) => v)).toEqual(["default-src 'self'", APP_SANDBOX]);
  });

  it("never lets an app have the microphone, whatever it asks for", () => {
    const out = appResponseHeaders([["Permissions-Policy", "microphone=*, geolocation=()"]], ctx);
    // Its own policy stays; ours comes last, and a repeated key's last value wins.
    expect(out.filter(([n]) => n.toLowerCase() === "permissions-policy").map(([, v]) => v)).toEqual(["microphone=*, geolocation=()", APP_PERMISSIONS]);
  });

  it("answers CORS for the app's own opaque origin, and only that", () => {
    const withNull = appResponseHeaders(
      [
        ["Content-Type", "text/javascript"],
        ["Access-Control-Allow-Origin", "*"],
        ["X-Total", "3"],
      ],
      { ...ctx, origin: "null" },
    );
    const get = (n: string) => withNull.filter(([k]) => k.toLowerCase() === n).map(([, v]) => v);
    expect(get("access-control-allow-origin")).toEqual(["null"]);
    expect(get("access-control-allow-credentials")).toEqual(["true"]);
    expect(get("vary")).toEqual(["Origin"]);
    expect(get("access-control-expose-headers")[0]).toContain("x-total");

    const other = appResponseHeaders([["Content-Type", "text/plain"]], { ...ctx, origin: "https://evil.example" });
    expect(other.some(([n]) => n.toLowerCase().startsWith("access-control-"))).toBe(false);
  });

  it("answers a preflight itself, echoing what was asked", () => {
    const h = { origin: "null", "access-control-request-method": "PUT", "access-control-request-headers": "content-type, x-csrf, bad header" };
    expect(isNullPreflight("OPTIONS", h)).toBe(true);
    expect(isNullPreflight("OPTIONS", { origin: "https://x", "access-control-request-method": "PUT" })).toBe(false);
    expect(isNullPreflight("OPTIONS", { origin: "null" })).toBe(false);
    const out = preflightHeaders(h);
    expect(out).toMatchObject({
      "access-control-allow-origin": "null",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "PUT",
      "access-control-allow-headers": "content-type, x-csrf",
      "access-control-max-age": "600",
    });
  });

  it("lets a change come from the app, the box or a client without an origin — never another site", () => {
    expect(appOriginAllowed({ origin: "null", host: "box" })).toBe(true);
    expect(appOriginAllowed({ host: "box" })).toBe(true);
    expect(appOriginAllowed({ origin: "https://box", host: "box" })).toBe(true);
    expect(appOriginAllowed({ origin: "https://evil.example", host: "box" })).toBe(false);
    expect(appOriginAllowed({ origin: "garbage", host: "box" })).toBe(false);
  });

  it("knows what it may edit, and what a font is", () => {
    expect(editableType("text/html; charset=utf-8")).toBe("html");
    expect(editableType("text/css")).toBe("css");
    expect(editableType("text/javascript")).toBeNull();
    expect(isFontType("font/woff2")).toBe(true);
    expect(isFontType("application/font-woff")).toBe(true);
    expect(isFontType("text/html")).toBe(false);
    expect(isFontType(undefined)).toBe(false);
  });
});
