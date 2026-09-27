import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { SessionHub } from "../src/herdr/session.js";
import { loadConfig, type Config } from "../src/config.js";
import { startTestHerdr, TestHerdr } from "./helpers/herdr.js";
import type { EventsMessage } from "@workbench/shared";

let h: TestHerdr;
let hub: SessionHub;
let app: FastifyInstance;
let config: Config;
let baseUrl: string;

beforeAll(async () => {
  h = await startTestHerdr();
  config = loadConfig({
    HERDR_SOCKET_PATH: h.socketPath,
    WORKBENCH_PORT: "0",
    WORKBENCH_STATIC_DIR: "/does/not/exist-workbench-static",
  });
  hub = new SessionHub(config.socketPath);
  await hub.start();
  app = await buildApp(config, { hub });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `127.0.0.1:${port}`;
}, 25_000);

afterAll(async () => {
  await app.close();
  hub.stop();
  await h.stop();
});

describe("bridge app", () => {
  it("tolerates a missing static dir and serves health", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.herdr.connected).toBe(true);
    expect(body.herdr.version).toMatch(/^\d+\./);
    // The app reads these from health: the picker's root, and the preview
    // configuration the inspector needs.
    expect(typeof body.workspaceRoot).toBe("string");
    expect(body).toHaveProperty("previewDomain");
  });

  it("refuses non-allowlisted RPC methods with 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/rpc",
      payload: { method: "server.stop" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "method not allowed" });
  });

  it("rejects an RPC body without a string method with 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/rpc", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("streams a snapshot then live events on /ws/events", async () => {
    const ws = new WebSocket(`ws://${baseUrl}/ws/events`, { origin: `http://${baseUrl}` });
    const messages: EventsMessage[] = [];
    const first = new Promise<void>((resolve, reject) => {
      ws.once("error", reject);
      ws.on("message", (raw) => {
        messages.push(JSON.parse(raw.toString()) as EventsMessage);
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    await first;
    expect(messages[0]?.kind).toBe("snapshot");

    const res = await app.inject({
      method: "POST",
      url: "/api/rpc",
      payload: { method: "workspace.create", params: { cwd: h.dir, label: "x" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toBeTruthy();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no workspace_created event")), 8_000);
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString()) as EventsMessage;
        if (m.kind === "event" && m.event === "workspace_created") {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
  });
});
