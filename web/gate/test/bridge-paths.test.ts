import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PASSWORD, login, openWs, request, sameOrigin, startHarness, type Harness } from "./helpers.js";

// The bridge paths the gate treats specially: the WebDAV mount, whose
// filenames may hold characters the path guard otherwise refuses, and the
// editor channel and the usage report, which are for the sandbox alone.

let h: Harness;
let cookie: string;
let bearer: Record<string, string>;

beforeAll(async () => {
  h = await startHarness();
  cookie = await login(h);
  const s = (await request(h.base, "POST", "/_gate/device/start", { body: { name: "mount" } })).json<{ deviceCode: string; userCode: string }>();
  await request(h.base, "POST", "/_gate/device/approve", { headers: sameOrigin(h, { cookie }), body: { userCode: s.userCode, password: PASSWORD } });
  const { token } = (await request(h.base, "POST", "/_gate/device/poll", { body: { deviceCode: s.deviceCode } })).json<{ token: string }>();
  bearer = { authorization: `Bearer ${token}` };
});
afterAll(async () => h.close());

/** Raw paths a WebDAV client sends for awkward names, and ones that try to climb out. */
const DAV_PATHS = [
  "/api/dav/a;b.txt",
  "/api/dav/a%3Bb%5Cc",
  "/api/dav/dir%20x/50%25.txt",
  "/api/dav/..%2f..%2fvscode/",
  "/api/dav/%2e%2e/%2e%2e/terminal/",
  "/api/dav/../../vscode/",
  "/api/dav/..%5c..%5cshell/",
];

describe("the WebDAV mount", () => {
  it("takes filenames the path guard would refuse elsewhere, to the bridge, exactly as sent", async () => {
    for (const p of DAV_PATHS) {
      for (const method of ["GET", "PROPFIND", "PUT", "DELETE"]) {
        const res = await request(h.base, method, p, { headers: { ...bearer, depth: "0" }, ...(method === "PUT" ? { body: "x" } : {}) });
        expect(res.status, `${method} ${p}`).toBe(200);
        // The bridge, at the raw path — never the editor or a shell, never a
        // path the gate re-read.
        expect(res.json(), `${method} ${p}`).toMatchObject({ echo: "bridge", url: p, method });
      }
    }
  });

  it("works with a session too, for what a browser may send", async () => {
    const res = await request(h.base, "GET", "/api/dav/a;b.txt", { headers: { cookie } });
    expect(res.json()).toMatchObject({ echo: "bridge", url: "/api/dav/a;b.txt" });
  });

  it("is still behind sign-in, whatever the path", async () => {
    const before = h.allSeen().length;
    for (const p of DAV_PATHS) {
      for (const method of ["GET", "PROPFIND", "PUT", "DELETE", "MOVE"]) {
        const res = await request(h.base, method, p, { headers: { depth: "0", destination: "/api/dav/x" } });
        expect(res.status, `${method} ${p}`).toBe(401);
      }
    }
    expect(h.allSeen().length).toBe(before);
  });

  it("lends its exemption to nothing that merely resembles it", async () => {
    const before = h.allSeen().length;
    for (const p of ["/api/davx;y", "/api/dav;/../../vscode/", "/api%2fdav/..%2fvscode/", "//api/dav/a;b", "/./api/dav/a;b"]) {
      const res = await request(h.base, "GET", p, { headers: bearer });
      expect(res.status, p).toBe(400);
    }
    expect(h.allSeen().length).toBe(before);
  });
});

describe("the editor channel", () => {
  it("is not found from outside, signed in or not, by request or by WebSocket", async () => {
    const before = h.allSeen().length;
    for (const p of ["/ws/editor", "/ws/editor/", "/ws/editor/x?y=1", "/ws/%65ditor", "/%77s/editor", "/ws/%65%64itor/x"]) {
      for (const headers of [{}, { cookie }, bearer]) {
        expect((await request(h.base, "GET", p, { headers })).status, p).toBe(404);
      }
      for (const headers of [{ origin: h.base }, { origin: h.base, cookie }, bearer]) {
        expect(await openWs(`ws://127.0.0.1:${h.port}${p}`, headers), p).toEqual({ status: 404 });
      }
    }
    expect(h.allSeen().length).toBe(before);
  });

  it("forwards an escaped ordinary character as the character itself", async () => {
    const res = await request(h.base, "GET", "/api/%68ealth", { headers: bearer });
    expect(res.json()).toMatchObject({ echo: "bridge", url: "/api/health" });
  });

  it("leaves the app's own sockets alone", async () => {
    const res = await openWs(`ws://127.0.0.1:${h.port}/ws/events`, { origin: h.base, cookie });
    expect("status" in res ? res.status : 101).toBe(101);
    if ("ws" in res) res.ws.close();
  });
});

describe("the usage report", () => {
  it("is not found from outside, signed in or not", async () => {
    const before = h.allSeen().length;
    for (const p of ["/api/usage/report", "/api/usage/report/", "/api/usage/%72eport", "/api/%75sage/report?x=1"]) {
      for (const headers of [{}, { ...sameOrigin(h, { cookie }) }, bearer]) {
        expect((await request(h.base, "POST", p, { headers, body: { status: { session_id: "x" } } })).status, p).toBe(404);
      }
    }
    expect(h.allSeen().length).toBe(before);
  });

  it("leaves the meters themselves to the bridge", async () => {
    const res = await request(h.base, "GET", "/api/usage", { headers: bearer });
    expect(res.json()).toMatchObject({ echo: "bridge", url: "/api/usage" });
  });
});
