import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { SessionHub } from "../src/herdr/session.js";

// The app at `/`: static files, history-API routing, and the old prefix.
const stubHub = {
  connected: false,
  version: null,
  protocol: null,
  snapshot: async () => ({}),
  on: () => () => {},
  start: async () => {},
  stop: () => {},
} as unknown as SessionHub;

const INDEX = "<!doctype html><title>app</title>";

let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  const root = fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : os.tmpdir();
  dir = fs.mkdtempSync(path.join(root, "wb-root-"));
  fs.writeFileSync(path.join(dir, "index.html"), INDEX);
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets", "index-abc123.js"), "export {};\n");

  const config = loadConfig({
    WORKBENCH_PORT: "0",
    HERDR_SOCKET_PATH: "/does/not/exist-root.sock",
    WORKBENCH_STATIC_DIR: dir,
  });
  app = await buildApp(config, { hub: stubHub });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the app at the root", () => {
  it("serves index.html at /", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("serves a built asset", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("export {};\n");
    // Hashed names never change, so a browser may keep them for good.
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("answers every route the app owns with index.html, so deep links survive a reload", async () => {
    for (const url of ["/workbench", "/editor", "/files/src/a.ts", "/apps/abc", "/system", "/settings/devices?code=AB12-CD34"]) {
      const res = await app.inject({ method: "GET", url, headers: { "sec-fetch-dest": "document" } });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toBe(INDEX);
      expect(res.headers["content-type"], url).toMatch(/^text\/html/);
      expect(res.headers["cache-control"], url).toBe("no-cache");
    }
  });

  it("treats a client that does not say what it is loading as navigating", async () => {
    const res = await app.inject({ method: "GET", url: "/files/deep/path" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
  });

  it("never hands a page to a subresource load", async () => {
    for (const dest of ["script", "style", "image", "font", "empty"]) {
      const res = await app.inject({ method: "GET", url: "/files/x.js", headers: { "sec-fetch-dest": dest } });
      expect(res.statusCode, dest).toBe(404);
    }
  });

  it("keeps the API, sockets, proxies and assets out of the fallback", async () => {
    for (const url of ["/api/nope", "/ws/nope", "/assets/missing.js", "/s/nope", "/api"]) {
      const res = await app.inject({ method: "GET", url, headers: { "sec-fetch-dest": "document" } });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toBe(INDEX);
    }
  });

  it("does not answer other methods with the page", async () => {
    const res = await app.inject({ method: "POST", url: "/files/x", payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

describe("the old /workbench/ prefix", () => {
  it("redirects permanently to the Workbench route", async () => {
    for (const url of ["/workbench/", "/workbench/api/health", "/workbench/some/deep/route"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(301);
      expect(res.headers.location, url).toBe("/workbench");
    }
  });

  it("keeps the query, so an old review link still opens its review", async () => {
    const res = await app.inject({ method: "GET", url: "/workbench/?review=0123abcd" });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe("/workbench?review=0123abcd");
  });

  it("does not redirect a path that merely starts with the word", async () => {
    const res = await app.inject({ method: "GET", url: "/workbenches" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
  });
});
