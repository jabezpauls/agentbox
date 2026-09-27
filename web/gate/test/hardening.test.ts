import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, request, startHarness, type Harness } from "./helpers.js";

let h: Harness;
let cookie: string;

beforeAll(async () => {
  h = await startHarness();
  cookie = await login(h);
});
afterAll(async () => h.close());

describe("service workers", () => {
  it("are refused their script anywhere but the editor, and never reach the sandbox", async () => {
    const before = h.allSeen().length;
    for (const p of ["/sw.js", "/workbench/sw.js", "/workbench/preview/3000/sw.js", "/terminal/sw.js", "/login", "/_gate/sw.js", "/cli/agentbox.mjs"]) {
      const res = await request(h.base, "GET", p, { headers: { cookie, "service-worker": "script" } });
      expect(res.status, p).toBe(403);
    }
    expect(h.allSeen().length).toBe(before);
    // code-server's own workers live under its prefix.
    const editor = await request(h.base, "GET", "/vscode/static/out/sw.js", { headers: { cookie, "service-worker": "script" } });
    expect(editor.status).toBe(200);
    expect(editor.json()).toMatchObject({ echo: "code", url: "/static/out/sw.js" });
  });

  it("can never claim a scope above their script: the sandbox's Service-Worker-Allowed is stripped", async () => {
    h.echoes.bridge.respondWith = [["Service-Worker-Allowed", "/"]];
    h.echoes.terminal.respondWith = [["Service-Worker-Allowed", "/"]];
    try {
      for (const p of ["/workbench/x.js", "/terminal/x.js"]) {
        const res = await request(h.base, "GET", p, { headers: { cookie } });
        expect(res.status, p).toBe(200);
        expect(res.headers["service-worker-allowed"], p).toBeUndefined();
      }
    } finally {
      h.echoes.bridge.respondWith = [];
      h.echoes.terminal.respondWith = [];
    }
  });

  it("the editor's scope is moved under /vscode/, never above it", async () => {
    // Only exactly "/" is taken, and becomes the editor's prefix. Anything else
    // is dropped: appended to /vscode, the browser would resolve dot segments,
    // encoded or not, and backslashes back out of it.
    const cases: Array<[string, string | undefined]> = [
      ["/", "/vscode/"],
      [" / ", "/vscode/"],
      ["/_static/out/", undefined],
      ["/%2e%2e/", undefined],
      ["/.%2e/", undefined],
      ["/%2E./", undefined],
      ["/%2e%2e", undefined],
      ["/%2f", undefined],
      ["%2f", undefined],
      ["/%2F%2e%2e%2F", undefined],
      ["/\\", undefined],
      ["\\", undefined],
      ["/..\\", undefined],
      ["/../", undefined],
      ["/./", undefined],
      ["//", undefined],
      ["//evil.example/", undefined],
      ["https://evil.example/", undefined],
      ["http://127.0.0.1/", undefined],
      ["relative/", undefined],
      ["", undefined],
    ];
    try {
      for (const [sent, seen] of cases) {
        h.echoes.code.respondWith = [["Service-Worker-Allowed", sent]];
        const res = await request(h.base, "GET", "/vscode/_static/out/browser/serviceWorker.js", { headers: { cookie } });
        expect(res.headers["service-worker-allowed"], sent).toBe(seen);
      }
    } finally {
      h.echoes.code.respondWith = [];
    }
  });
});

describe("refusals", () => {
  function trickle(port: number, path: string, headers = ""): Promise<{ closedAfterMs: number; status: string }> {
    return new Promise((resolve) => {
      const started = Date.now();
      let got = "";
      const sock = net.connect(port, "127.0.0.1", () =>
        sock.write(`POST ${path} HTTP/1.1\r\nHost: x\r\n${headers}Content-Type: application/json\r\nContent-Length: 1000000\r\n\r\n{`),
      );
      const drip = setInterval(() => sock.write(" "), 100);
      sock.on("data", (d) => (got += d.toString()));
      sock.on("error", () => {});
      sock.on("close", () => {
        clearInterval(drip);
        resolve({ closedAfterMs: Date.now() - started, status: got.split("\r\n")[0] ?? "" });
      });
      setTimeout(() => sock.destroy(), 8_000);
    });
  }

  it("close the connection, so a body trickling in behind them cannot hold it", async () => {
    // Deadlines far away: only the refusal's own Connection: close can end these.
    const hh = await startHarness({}, { timeouts: { gateRequestMs: 60_000, headersMs: 60_000 } });
    try {
      const upstream = await trickle(hh.port, "/workbench/api/rpc");
      expect(upstream.status).toBe("HTTP/1.1 401 Unauthorized");
      expect(upstream.closedAfterMs).toBeLessThan(2_000);
      const gate = await trickle(hh.port, "/_gate/login");
      expect(gate.status).toBe("HTTP/1.1 403 Forbidden");
      expect(gate.closedAfterMs).toBeLessThan(2_000);
    } finally {
      await hh.close();
    }
  });

  it("but an answered request leaves a keep-alive connection open, without piling up listeners", async () => {
    const hh = await startHarness({}, { timeouts: { gateRequestMs: 300, headersMs: 300 } });
    try {
      let serverSide: net.Socket | null = null;
      hh.gate.server.once("connection", (s: net.Socket) => (serverSide = s));
      const sock = net.connect(hh.port, "127.0.0.1");
      let got = "";
      sock.on("data", (d) => (got += d.toString()));
      await new Promise<void>((r) => sock.once("connect", () => r()));
      for (let i = 0; i < 15; i++) sock.write("GET /login/assets/login.css HTTP/1.1\r\nHost: x\r\n\r\n");
      // Idle for longer than both deadlines.
      await new Promise((r) => setTimeout(r, 1_000));
      sock.write("GET /login HTTP/1.1\r\nHost: x\r\n\r\n");
      await new Promise((r) => setTimeout(r, 300));
      expect(sock.destroyed).toBe(false);
      expect(got.match(/HTTP\/1\.1 200 OK/g)?.length).toBe(16);
      // Sixteen requests on one socket, and no listener left behind per request.
      expect((serverSide as net.Socket | null)?.listenerCount("close") ?? 99).toBeLessThan(5);
      sock.destroy();
    } finally {
      await hh.close();
    }
  });
});

describe("same-origin form posts", () => {
  it("are accepted with Origin: null when the browser says Sec-Fetch-Site: same-origin", async () => {
    const res = await request(h.base, "POST", "/workbench/api/thing", {
      headers: { cookie, origin: "null", "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(res.status).toBe(200);
  });

  it("are refused with Origin: null from an opaque document, which the browser marks cross-site", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      const res = await request(h.base, "POST", "/workbench/api/thing", {
        headers: { cookie, origin: "null", "sec-fetch-site": site },
        body: "a=1",
      });
      expect(res.status, site).toBe(403);
    }
  });

  it("come from the gate's pages with a real Origin: they are served with Referrer-Policy: same-origin", async () => {
    const page = await request(h.base, "GET", "/login");
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    expect(page.body).not.toContain('name="referrer"');
    // Everything else the gate answers still sends no referrer at all.
    const api = await request(h.base, "GET", "/_gate/session", { headers: { cookie } });
    expect(api.headers["referrer-policy"]).toBe("no-referrer");
  });
});

function rawRequest(port: number, text: string): Promise<{ closedAfterMs: number; response: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let response = "";
    const sock = net.connect(port, "127.0.0.1", () => sock.write(text));
    sock.on("data", (d) => (response += d.toString()));
    sock.on("close", () => resolve({ closedAfterMs: Date.now() - started, response }));
    sock.on("error", () => {});
  });
}

describe("deadlines", () => {
  it("close a request to the gate's own endpoints whose body never arrives", async () => {
    const hh = await startHarness({}, { timeouts: { gateRequestMs: 300 } });
    try {
      // Refused early (no Origin) or read in full (same origin): either way the
      // connection must not outlive the deadline.
      for (const origin of ["", `Origin: http://x\r\n`]) {
        const partial = `POST /_gate/login HTTP/1.1\r\nHost: x\r\n${origin}Content-Type: application/json\r\nContent-Length: 200\r\n\r\n{"user`;
        const res = await rawRequest(hh.port, partial);
        expect(res.closedAfterMs, origin || "no origin").toBeLessThan(3_000);
      }
    } finally {
      await hh.close();
    }
  });

  it("close a connection whose headers never finish", async () => {
    const hh = await startHarness({}, { timeouts: { headersMs: 300 } });
    try {
      const res = await rawRequest(hh.port, "GET /login HTTP/1.1\r\nHost: x\r\n");
      expect(res.closedAfterMs).toBeLessThan(3_000);
    } finally {
      await hh.close();
    }
  });

  it("leave a slow proxied upload alone", async () => {
    const hh = await startHarness({}, { timeouts: { gateRequestMs: 200 } });
    try {
      const c = await login(hh);
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const r = http.request(
          {
            host: "127.0.0.1",
            port: hh.port,
            method: "POST",
            path: "/workbench/api/upload",
            headers: { cookie: c, origin: hh.base, "content-length": "10" },
            agent: false,
          },
          (resp) => {
            let body = "";
            resp.on("data", (d: Buffer) => (body += d.toString()));
            resp.on("end", () => resolve({ status: resp.statusCode ?? 0, body }));
          },
        );
        r.on("error", reject);
        r.write("12345");
        setTimeout(() => r.end("67890"), 600);
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).body).toBe("1234567890");
    } finally {
      await hh.close();
    }
  });
});
