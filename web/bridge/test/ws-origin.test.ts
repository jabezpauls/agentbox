import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ClientOptions } from "ws";
import { WebSocket } from "ws";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import type { SessionHub } from "../src/herdr/session.js";
import type { TerminalStreams } from "../src/herdr/terminal.js";
import { isSameOrigin } from "../src/ws-origin.js";

// The origin check runs before any handler, so neither herdr nor a real
// terminal stream is needed: stubs keep the routes registrable.
const stubHub = {
  connected: false,
  version: null,
  protocol: null,
  snapshot: async () => ({}),
  on: () => () => {},
  start: async () => {},
  stop: () => {},
} as unknown as SessionHub;

const stubStreams = {
  attach: () => ({
    input: () => {},
    resize: () => {},
    scroll: () => {},
    focus: () => {},
    detach: () => {},
  }),
  stop: () => {},
} as unknown as TerminalStreams;

let app: FastifyInstance;
let config: Config;
let baseUrl: string;

beforeAll(async () => {
  config = loadConfig({
    WORKBENCH_PORT: "0",
    HERDR_SOCKET_PATH: "/does/not/exist-ws-origin.sock",
    WORKBENCH_STATIC_DIR: "/does/not/exist-ws-origin-static",
  });
  app = await buildApp(config, { hub: stubHub, streams: stubStreams });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  baseUrl = `127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
});

/** Resolves with the handshake status when the upgrade is refused. */
function refusedStatus(path: string, options: ClientOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${baseUrl}${path}`, options);
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    ws.once("open", () => {
      ws.close();
      reject(new Error("upgrade was accepted"));
    });
    ws.once("error", (err) => reject(err));
  });
}

/** Resolves once the upgrade is accepted (the handler may close afterwards). */
function accepted(path: string, options: ClientOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${baseUrl}${path}`, options);
    ws.once("open", () => {
      ws.close();
      resolve();
    });
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      reject(new Error(`upgrade refused with ${res.statusCode}`));
    });
    ws.once("error", (err) => reject(err));
  });
}

const EVENTS = "/ws/events";
const TERMINAL = "/ws/terminal?pane=w1:p1";

describe("websocket origin checks", () => {
  const ROUTES: { name: string; path(): string }[] = [
    { name: "events", path: () => EVENTS },
    { name: "terminal", path: () => TERMINAL },
  ];

  for (const route of ROUTES) {
    describe(route.name, () => {
      it("accepts a same-origin upgrade", async () => {
        await expect(accepted(route.path(), { origin: `http://${baseUrl}` })).resolves.toBeUndefined();
      });

      it("rejects a foreign origin", async () => {
        await expect(refusedStatus(route.path(), { origin: "http://evil.example" })).resolves.toBe(403);
      });

      it("rejects Origin: null", async () => {
        await expect(refusedStatus(route.path(), { origin: "null" })).resolves.toBe(403);
      });

      it("rejects a missing Origin", async () => {
        await expect(refusedStatus(route.path(), {})).resolves.toBe(403);
      });
    });
  }

  it("accepts an https origin behind TLS termination, whatever the forwarded scheme says", async () => {
    // Caddy is the last hop and rewrites X-Forwarded-Proto to its own
    // listener's scheme, so behind a Cloudflare Tunnel (or any TLS-terminating
    // proxy) the browser's https origin arrives alongside a forwarded "http".
    // Comparing schemes here would refuse every upgrade on the recommended
    // deployment; only the host is compared.
    await expect(
      accepted(EVENTS, {
        origin: `https://${baseUrl}`,
        headers: { "x-forwarded-proto": "http" },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects an origin with a scheme no browser would send", async () => {
    await expect(refusedStatus(EVENTS, { origin: `ftp://${baseUrl}` })).resolves.toBe(403);
  });

  it("rejects an origin that only looks like this host", async () => {
    await expect(refusedStatus(EVENTS, { origin: `http://${baseUrl}.evil.example` })).resolves.toBe(
      403,
    );
  });

  it("serves no preview proxy on the control plane: apps are the data plane's", async () => {
    const res = await app.inject({ method: "GET", url: "/preview/3000/" });
    expect(res.statusCode).toBe(404);
  });
});

// The header comparison itself, at the shape a real deployment produces.
describe("isSameOrigin", () => {
  const req = (headers: Record<string, string>): FastifyRequest =>
    ({ headers }) as unknown as FastifyRequest;

  it("accepts the browser's https origin behind a TLS-terminating proxy", () => {
    // Cloudflare Tunnel in front of Caddy: the tunnel terminates TLS, Caddy
    // rewrites X-Forwarded-Proto to its own plain listener, and the Host is
    // carried through untouched. Only the host may be compared.
    expect(
      isSameOrigin(
        req({
          origin: "https://code.example.com",
          host: "code.example.com",
          "x-forwarded-proto": "http",
        }),
      ),
    ).toBe(true);
  });

  it("refuses a different host, a look-alike, null and an absent origin", () => {
    expect(isSameOrigin(req({ origin: "https://evil.example", host: "code.example.com" }))).toBe(false);
    expect(isSameOrigin(req({ origin: "https://code.example.com.evil.example", host: "code.example.com" }))).toBe(false);
    expect(isSameOrigin(req({ origin: "null", host: "code.example.com" }))).toBe(false);
    expect(isSameOrigin(req({ host: "code.example.com" }))).toBe(false);
  });
});
