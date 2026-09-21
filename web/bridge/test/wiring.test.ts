import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import type { ListeningPort, EventsMessage } from "@workbench/shared";
import { buildApp, type PortsWatcher } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import type { SessionHub } from "../src/herdr/session.js";

const stubHub = {
  connected: false,
  version: null,
  protocol: null,
  snapshot: async () => ({ workspaces: [] }),
  on: () => () => {},
  start: async () => {},
  stop: () => {},
} as unknown as SessionHub;

class FakeWatcher implements PortsWatcher {
  starts = 0;
  stops = 0;
  private ports: ListeningPort[] = [];
  private listeners = new Set<(p: ListeningPort[]) => void>();
  current(): ListeningPort[] {
    return this.ports;
  }
  on(listener: (p: ListeningPort[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  start(): void {
    this.starts += 1;
  }
  stop(): void {
    this.stops += 1;
  }
  emit(ports: ListeningPort[]): void {
    this.ports = ports;
    for (const l of this.listeners) l(ports);
  }
}

let root: string;
let app: FastifyInstance;
let config: Config;
let watcher: FakeWatcher;
let baseUrl: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-wire-"));
  fs.mkdirSync(path.join(root, "projectA"));
  watcher = new FakeWatcher();
  config = loadConfig({
    WORKBENCH_PORT: "0",
    WORKBENCH_BASE_PATH: "/workbench",
    HERDR_SOCKET_PATH: "/does/not/exist-wire.sock",
    WORKBENCH_STATIC_DIR: "/does/not/exist-wire-static",
    WORKBENCH_WORKSPACE_ROOT: root,
  });
  app = await buildApp(config, { hub: stubHub, ports: watcher });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("wired read endpoints", () => {
  it("serves the current ports from the watcher", async () => {
    watcher.emit([
      { port: 3000, pid: 10, process: "node", system: false, address: "0.0.0.0" },
    ]);
    const res = await app.inject({ method: "GET", url: "/workbench/api/ports" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { port: 3000, pid: 10, process: "node", system: false, address: "0.0.0.0" },
    ]);
  });

  it("lists workspace directories and rejects escapes with 400", async () => {
    const ok = await app.inject({ method: "GET", url: "/workbench/api/fs/dirs?path=" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual([{ name: "projectA", path: "projectA" }]);
    const bad = await app.inject({ method: "GET", url: "/workbench/api/fs/dirs?path=.." });
    expect(bad.statusCode).toBe(400);
  });
});

describe("events websocket ports push", () => {
  it("sends a ports message on connect and on change, and ref-counts the watcher", async () => {
    const startsBefore = watcher.starts;
    const ws = new WebSocket(`ws://${baseUrl}/workbench/ws/events`, { origin: `http://${baseUrl}` });
    const kinds: string[] = [];
    const gotPorts = new Promise<EventsMessage>((resolve, reject) => {
      ws.once("error", reject);
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString()) as EventsMessage;
        kinds.push(m.kind);
        if (m.kind === "ports") resolve(m);
      });
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const first = await gotPorts;
    expect(first.kind).toBe("ports");
    expect(kinds[0]).toBe("snapshot");
    expect(watcher.starts).toBe(startsBefore + 1);

    const onChange = new Promise<EventsMessage>((resolve) => {
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString()) as EventsMessage;
        if (m.kind === "ports" && m.ports.length === 2) resolve(m);
      });
    });
    watcher.emit([
      { port: 3000, pid: 10, process: "node", system: false, address: "0.0.0.0" },
      { port: 4000, pid: 11, process: "vite", system: false, address: "0.0.0.0" },
    ]);
    const changed = await onChange;
    expect(changed.kind === "ports" && changed.ports.length).toBe(2);

    const stopsBefore = watcher.stops;
    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    // Give the close handler a tick to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(watcher.stops).toBe(stopsBefore + 1);
  });
});
