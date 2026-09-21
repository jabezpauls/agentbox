import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { SessionHub } from "../src/herdr/session.js";

// Static serving needs no herdr; a stub hub keeps the other routes registrable.
const stubHub = {
  connected: false,
  version: null,
  protocol: null,
  snapshot: async () => ({}),
  on: () => () => {},
  start: async () => {},
  stop: () => {},
} as unknown as SessionHub;

let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  const root = fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : os.tmpdir();
  dir = fs.mkdtempSync(path.join(root, "wb-static-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>app</title>");
  fs.writeFileSync(path.join(dir, "app.js"), "export {};\n");

  const config = loadConfig({
    WORKBENCH_PORT: "0",
    WORKBENCH_BASE_PATH: "/workbench",
    HERDR_SOCKET_PATH: "/does/not/exist-static.sock",
    WORKBENCH_STATIC_DIR: dir,
  });
  app = await buildApp(config, { hub: stubHub });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("static route framing headers", () => {
  // Framing the Workbench would let a hostile page overlay a live terminal.
  it("refuses foreign framing of a served asset", async () => {
    const res = await app.inject({ method: "GET", url: "/workbench/index.html" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("refuses foreign framing of the SPA fallback", async () => {
    const res = await app.inject({ method: "GET", url: "/workbench/some/client/route" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});
