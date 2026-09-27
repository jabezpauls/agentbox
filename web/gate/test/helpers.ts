import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { buildGate, type Gate, type GateDeps } from "../src/app.js";
import type { Config } from "../src/config.js";
import { hashPassword } from "../src/password.js";
import type { UpstreamName } from "../src/routes.js";

export const USER = "owner";
export const PASSWORD = "correct horse battery";
/** Cheap bcrypt for tests; production is 14. */
export const COST = 4;

let seedHash: string | null = null;
export async function seed(): Promise<string> {
  seedHash ??= await hashPassword(PASSWORD, COST);
  return seedHash;
}

/** Every stand-in: the sandbox services the route table names, and the bridge's data plane. */
export type EchoName = UpstreamName | "data";

export interface Seen {
  upstream: EchoName;
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * A stand-in for one sandbox service: answers every request with what it
 * received, and every WebSocket with the same, so a test can assert exactly
 * what crossed the gate.
 */
export interface Echo {
  name: EchoName;
  port: number;
  seen: Seen[];
  /** Extra response headers to send on the next plain responses. */
  respondWith: Array<[string, string]>;
  close(): Promise<void>;
}

export async function startEcho(name: EchoName): Promise<Echo> {
  const seen: Seen[] = [];
  const echo: Echo = { name, port: 0, seen, respondWith: [], close: async () => {} };
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ upstream: name, method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      const html = req.url?.includes("html");
      const headers: string[] = ["content-type", html ? "text/html" : "application/json"];
      for (const [n, v] of echo.respondWith) headers.push(n, v);
      res.writeHead(200, headers);
      res.end(
        JSON.stringify({
          echo: name,
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
  });
  server.on("upgrade", (req, socket, head) => {
    seen.push({ upstream: name, method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ echo: name, url: req.url, headers: req.headers }));
      ws.on("message", (m) => ws.send(m.toString()));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  echo.port = (server.address() as AddressInfo).port;
  echo.close = () =>
    new Promise((r) => {
      wss.close();
      server.closeAllConnections();
      server.close(() => r());
    });
  return echo;
}

export interface Harness {
  gate: Gate;
  port: number;
  base: string;
  /** The sandbox-side app API. */
  apps: string;
  echoes: Record<EchoName, Echo>;
  dataDir: string;
  /** Everything the upstreams saw, across all of them. */
  allSeen(): Seen[];
  close(): Promise<void>;
}

const staticDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/static");

export async function startHarness(overrides: Partial<Config> = {}, deps: GateDeps = {}): Promise<Harness> {
  const names: EchoName[] = ["code", "terminal", "shell", "monitor", "bridge", "data"];
  const echoes = {} as Record<EchoName, Echo>;
  for (const n of names) echoes[n] = await startEcho(n);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    adminSocket: path.join(dataDir, "admin.sock"),
    user: USER,
    seedPasswordHash: await seed(),
    bcryptCost: COST,
    trustedProxies: [],
    publicUrl: null,
    upstreams: Object.fromEntries(
      names.filter((n) => n !== "data").map((n) => [n, { host: "127.0.0.1", port: echoes[n].port }]),
    ) as Config["upstreams"],
    dataPlane: { host: "127.0.0.1", port: echoes.data.port },
    appsHost: "127.0.0.1",
    appsPort: 0,
    infraPorts: [8080, 7681, 7682, 7683, 7800, 7801, 7900, 7901, ...names.map((n) => echoes[n].port)],
    sharing: true,
    staticDir,
    cliDir: path.join(dataDir, "cli"),
    version: "9.9.9-test",
    ...overrides,
  };
  const gate = await buildGate(config, deps);
  await gate.app.listen({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => gate.sandboxServer.listen(0, "127.0.0.1", r));
  const port = (gate.server.address() as AddressInfo).port;
  return {
    gate,
    port,
    base: `http://127.0.0.1:${port}`,
    apps: `http://127.0.0.1:${(gate.sandboxServer.address() as AddressInfo).port}`,
    echoes,
    dataDir,
    allSeen: () => names.flatMap((n) => echoes[n].seen),
    close: async () => {
      gate.server.closeAllConnections();
      await gate.close();
      for (const n of names) await echoes[n].close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json<T = Record<string, unknown>>(): T;
}

/** A raw HTTP request: no redirects followed, no headers added behind the test's back. */
export function request(
  base: string,
  method: string,
  target: string,
  opts: { headers?: Record<string, string>; body?: string | object } = {},
): Promise<Res> {
  const url = new URL(base);
  let payload: string | undefined;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) {
    payload = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    if (typeof opts.body !== "string" && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
    // Node frames a DELETE body only when told its length, as a browser does.
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, method, path: target, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: <T>() => JSON.parse(body) as T,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** The value to send back as `Cookie` from a response's Set-Cookie. */
export function cookieFrom(res: Res): string {
  const set = res.headers["set-cookie"] ?? [];
  const first = set[0] ?? "";
  return first.split(";")[0] ?? "";
}

/** Headers a same-origin browser request carries. */
export function sameOrigin(h: Harness, extra: Record<string, string> = {}): Record<string, string> {
  return { origin: h.base, ...extra };
}

/** Sign in through the API and return the session cookie pair. */
export async function login(h: Harness, extra: { remember?: boolean; code?: string; ip?: string } = {}): Promise<string> {
  const headers: Record<string, string> = sameOrigin(h);
  // As the proxy states it; believed only when the harness trusts loopback.
  if (extra.ip) headers["x-agentbox-client-ip"] = extra.ip;
  const res = await request(h.base, "POST", "/_gate/login", {
    headers,
    body: { username: USER, password: PASSWORD, remember: extra.remember ?? false, ...(extra.code ? { code: extra.code } : {}) },
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.body}`);
  return cookieFrom(res);
}

export function openWs(
  url: string,
  headers: Record<string, string>,
  protocols: string[] = [],
): Promise<{ ws: WebSocket; first: Record<string, unknown> } | { status: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, { headers });
    ws.once("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      res.resume();
    });
    ws.once("message", (m) => resolve({ ws, first: JSON.parse(m.toString()) as Record<string, unknown> }));
    ws.once("error", (err) => reject(err));
  });
}
