import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cookieFrom, login, openWs, request, sameOrigin, startHarness, type Harness } from "./helpers.js";

let h: Harness;
let cookie: string;

beforeAll(async () => {
  h = await startHarness();
  cookie = await login(h);
});
afterAll(async () => h.close());

const nav = { "sec-fetch-mode": "navigate", accept: "text/html" };

describe("without a session", () => {
  it("a page load is sent to sign in, remembering where it was going", async () => {
    const res = await request(h.base, "GET", "/workbench/?review=abc", { headers: nav });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/login?next=${encodeURIComponent("/workbench/?review=abc")}`);
  });

  it("a script's request gets a 401 that says where to sign in", async () => {
    const res = await request(h.base, "GET", "/workbench/api/health", { headers: { accept: "application/json" } });
    expect(res.status).toBe(401);
    expect(res.headers["x-agentbox-login"]).toBe("/login");
  });

  it("reaches no upstream by any route", async () => {
    const before = h.allSeen().length;
    for (const p of ["/", "/vscode/", "/terminal/", "/terminal/ws", "/shell/", "/monitor/", "/workbench/api/health", "/s/0123456789abcdef0123456789abcdef/", "/a/abc/"]) {
      for (const method of ["GET", "POST", "PUT", "DELETE", "OPTIONS"]) {
        const res = await request(h.base, method, p, { headers: { origin: h.base } });
        expect([302, 401], `${method} ${p}`).toContain(res.status);
      }
    }
    expect(h.allSeen().length).toBe(before);
  });

  it("refuses path tricks before routing, signed in or not", async () => {
    const before = h.allSeen().length;
    for (const p of [
      "/login/../terminal/",
      "/login/..%2f..%2fterminal/",
      "/_gate/%2e%2e/vscode/",
      "/cli/..%5cvscode/",
      "//terminal/",
      "/login;/../shell/",
      "/./vscode/",
      "/vscode/../terminal/",
    ]) {
      for (const headers of [{}, { cookie }]) {
        const res = await request(h.base, "GET", p, { headers });
        expect(res.status, p).toBe(400);
      }
    }
    expect(h.allSeen().length).toBe(before);
  });

  it("an old browser's cached Basic credentials open nothing", async () => {
    const res = await request(h.base, "GET", "/vscode/", { headers: { authorization: "Basic b3duZXI6Y29ycmVjdCBob3JzZSBiYXR0ZXJ5" } });
    expect(res.status).toBe(401);
  });

  it("a forged session or a malformed token opens nothing", async () => {
    for (const headers of [
      { cookie: "__Host-agentbox=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { cookie: "__Host-agentbox=" },
      { authorization: "Bearer abx_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { authorization: "Bearer not-a-token" },
    ]) {
      expect((await request(h.base, "GET", "/workbench/api/health", { headers })).status).toBe(401);
    }
  });

  it("WebSocket upgrades are refused", async () => {
    const before = h.allSeen().length;
    const res = await openWs(`ws://127.0.0.1:${h.port}/terminal/ws`, { origin: h.base });
    expect(res).toEqual({ status: 401 });
    expect(h.allSeen().length).toBe(before);
  });
});

describe("with a session", () => {
  it("routes each path to its service", async () => {
    const cases: Array<[string, string, string]> = [
      ["/vscode/", "code", "/"],
      ["/vscode/stable-1/static/x.js?v=2", "code", "/stable-1/static/x.js?v=2"],
      ["/terminal/", "terminal", "/terminal/"],
      ["/shell/token", "shell", "/shell/token"],
      ["/monitor/", "monitor", "/monitor/"],
      ["/workbench/api/health", "bridge", "/workbench/api/health"],
      ["/", "bridge", "/"],
      ["/api/files/list?path=%2Fworkspace", "bridge", "/api/files/list?path=%2Fworkspace"],
    ];
    for (const [path, upstream, target] of cases) {
      const res = await request(h.base, "GET", path, { headers: { cookie } });
      expect(res.status, path).toBe(200);
      expect(res.json(), path).toMatchObject({ echo: upstream, url: target });
    }
  });

  it("sends /vscode to /vscode/ so the editor's relative assets resolve", async () => {
    const res = await request(h.base, "GET", "/vscode?folder=/workspace", { headers: { cookie } });
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe("/vscode/?folder=/workspace");
  });

  it("strips every front-door credential before the sandbox sees the request", async () => {
    const res = await request(h.base, "GET", "/workbench/api/health", {
      headers: {
        cookie: `theme=dark; ${cookie}; __Secure-agentbox-app=grant; other=1`,
        "proxy-authorization": "Basic eA==",
        "x-agentbox-public": "1",
        "x-forwarded-for": "6.6.6.6",
      },
    });
    const seen = res.json<{ headers: Record<string, string> }>().headers;
    expect(seen.cookie).toBe("theme=dark; other=1");
    expect(seen.authorization).toBeUndefined();
    expect(seen["proxy-authorization"]).toBeUndefined();
    expect(seen["x-agentbox-public"]).toBeUndefined();
    // Not a trusted proxy: the client's claim is replaced by the address it connected from.
    expect(seen["x-forwarded-for"]).toBe("127.0.0.1");
    expect(seen.host).toBe(`127.0.0.1:${h.port}`);
  });

  it("forwards request bodies intact", async () => {
    const res = await request(h.base, "POST", "/workbench/api/rpc", {
      headers: sameOrigin(h, { cookie }),
      body: { method: "session.snapshot", params: {} },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.json<{ body: string }>().body)).toEqual({ method: "session.snapshot", params: {} });
  });

  it("forwards a chunked body intact, whatever the method", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const r = http.request(
          {
            host: "127.0.0.1",
            port: h.port,
            method,
            path: "/workbench/api/thing",
            headers: { cookie, origin: h.base, "transfer-encoding": "chunked", "content-type": "text/plain" },
            agent: false,
          },
          (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c: Buffer) => chunks.push(c));
            resp.on("end", () => resolve({ status: resp.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        r.on("error", reject);
        r.write("first-");
        r.end("second");
      });
      expect(res.status, method).toBe(200);
      expect(JSON.parse(res.body).body, method).toBe("first-second");
    }
  });

  it("refuses a state-changing request from another site, and it never reaches the sandbox", async () => {
    const before = h.allSeen().length;
    for (const headers of [{ cookie }, { cookie, origin: "https://evil.example" }, { cookie, origin: "null" }, { cookie, "sec-fetch-site": "cross-site" }]) {
      const res = await request(h.base, "POST", "/workbench/api/rpc", { headers, body: "{}" });
      expect(res.status).toBe(403);
    }
    expect(h.allSeen().length).toBe(before);
    const ok = await request(h.base, "POST", "/workbench/api/rpc", { headers: { cookie, "sec-fetch-site": "same-origin" }, body: "{}" });
    expect(ok.status).toBe(200);
  });

  it("does not let the sandbox set or clear the gate's cookies", async () => {
    h.echoes.bridge.respondWith = [
      ["Set-Cookie", "__Host-agentbox=planted; Path=/; Secure; HttpOnly"],
      ["Set-Cookie", "__Secure-agentbox-app=planted; Path=/"],
      ["Set-Cookie", "app-session=kept; Path=/"],
    ];
    try {
      const res = await request(h.base, "GET", "/workbench/api/health", { headers: { cookie } });
      expect(res.headers["set-cookie"]).toEqual(["app-session=kept; Path=/"]);
    } finally {
      h.echoes.bridge.respondWith = [];
    }
  });

  it("adds the gate's security headers, and frame-ancestors on HTML", async () => {
    const json = await request(h.base, "GET", "/workbench/api/health", { headers: { cookie } });
    expect(json.headers["referrer-policy"]).toBe("no-referrer");
    expect(json.headers["x-content-type-options"]).toBe("nosniff");
    expect(json.headers["content-security-policy"]).toBeUndefined();
    const page = await request(h.base, "GET", "/workbench/page.html", { headers: { cookie } });
    expect(page.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
  });

  it("proxies WebSockets with the handshake checked and credentials stripped", async () => {
    const opened = await openWs(
      `ws://127.0.0.1:${h.port}/terminal/ws?arg=1`,
      { origin: h.base, cookie: `${cookie}; keep=1` },
      ["tty"],
    );
    if (!("ws" in opened)) throw new Error(`upgrade refused: ${opened.status}`);
    expect(opened.first.echo).toBe("terminal");
    expect(opened.first.url).toBe("/terminal/ws?arg=1");
    const seen = opened.first.headers as Record<string, string>;
    expect(seen.cookie).toBe("keep=1");
    expect(seen.origin).toBe(h.base);
    expect(seen["sec-websocket-protocol"]).toBe("tty");
    // Frames flow both ways, untouched.
    const reply = new Promise<string>((r) => opened.ws.once("message", (m) => r(m.toString())));
    opened.ws.send("ping");
    expect(await reply).toBe("ping");
    opened.ws.close();
  });

  it("refuses a WebSocket from another origin (cross-site WebSocket hijacking)", async () => {
    for (const origin of ["https://evil.example", "null", ""]) {
      const headers: Record<string, string> = { cookie };
      if (origin) headers.origin = origin;
      expect(await openWs(`ws://127.0.0.1:${h.port}/terminal/ws`, headers)).toEqual({ status: 403 });
    }
  });

  it("answers 502 when a service is down, without hanging", async () => {
    await h.echoes.monitor.close();
    const res = await request(h.base, "GET", "/monitor/", { headers: { cookie } });
    expect(res.status).toBe(502);
  });
});

describe("the sign-in page", () => {
  it("is served without a session, under a strict policy", async () => {
    const res = await request(h.base, "GET", "/login?next=/vscode/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(res.body).toContain('name="next" value="/vscode/"');
    expect(res.body).toContain('action="/_gate/login"');
  });

  it("escapes what it echoes and never keeps an off-site next", async () => {
    const res = await request(h.base, "GET", `/login?next=${encodeURIComponent('//evil.example/"><script>')}`);
    expect(res.body).toContain('name="next" value="/"');
    expect(res.body).not.toContain("<script>x");
  });

  it("sends a signed-in visitor straight on", async () => {
    const res = await request(h.base, "GET", "/login?next=/vscode/", { headers: { cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/vscode/");
  });

  it("serves its assets, and nothing else from the static directory", async () => {
    const css = await request(h.base, "GET", "/login/assets/login.css");
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
    expect((await request(h.base, "GET", "/login/assets/../../package.json")).status).toBe(400);
    expect((await request(h.base, "GET", "/login/assets/README.md")).status).toBe(404);
  });

  it("serves no CLI until one is shipped", async () => {
    expect((await request(h.base, "GET", "/cli/install")).status).toBe(404);
    expect((await request(h.base, "GET", "/cli/agentbox.mjs")).status).toBe(404);
    expect((await request(h.base, "GET", "/cli/other")).status).toBe(404);
  });

  it("gives an unknown /_gate path a 404 rather than the bridge", async () => {
    const res = await request(h.base, "GET", "/_gate/nothing", { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(cookieFrom(res)).toBe("");
  });
});
