import { describe, it, expect } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLavishSessions } from "../src/lavish.js";
import { loadConfig, type Config } from "../src/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureState = fs.readFileSync(path.join(here, "fixtures/lavish-state.json"), "utf8");

function configWith(overrides: Record<string, string>): Config {
  return loadConfig({ WORKBENCH_BASE_PATH: "/workbench", ...overrides });
}

function stateDirWithFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-lav-"));
  fs.writeFileSync(path.join(dir, "state.json"), fixtureState);
  return dir;
}

describe("readLavishSessions", () => {
  it("reports unconfigured when no lavish URL is set", async () => {
    const config = configWith({ WORKBENCH_LAVISH_URL: "" });
    const state = await readLavishSessions(config);
    expect(state).toEqual({ configured: false, url: null, running: false, sessions: [] });
  });

  it("lists sessions from state but reports not running when nothing listens", async () => {
    const dir = stateDirWithFixture();
    // Port 1 will not be listening, so /health fails fast.
    const config = configWith({
      WORKBENCH_LAVISH_URL: "https://lavish.example.com",
      LAVISH_AXI_STATE_DIR: dir,
      LAVISH_AXI_PORT: "1",
    });
    try {
      const state = await readLavishSessions(config);
      expect(state.configured).toBe(true);
      expect(state.url).toBe("https://lavish.example.com");
      expect(state.running).toBe(false);
      expect(state.sessions).toEqual([
        {
          key: "0011223344556677",
          label: "report.html",
          file: "/workspace/docs/report.html",
          status: "ended",
          url: "https://lavish.example.com/session/0011223344556677",
          active: false,
        },
        {
          key: "a1b2c3d4e5f60718",
          label: "index.html",
          file: "/workspace/site/index.html",
          status: "open",
          url: "https://lavish.example.com/session/a1b2c3d4e5f60718",
          active: false,
        },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports running and marks active listeners when the health endpoint answers", async () => {
    const dir = stateDirWithFixture();
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith("/health")) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            app: "lavish-axi",
            version: "0.1.75",
            listeners: [{ key: "a1b2c3d4e5f60718", label: "codex" }],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const config = configWith({
      WORKBENCH_LAVISH_URL: "https://lavish.example.com",
      LAVISH_AXI_STATE_DIR: dir,
      LAVISH_AXI_PORT: String(port),
    });
    try {
      const state = await readLavishSessions(config);
      expect(state.running).toBe(true);
      const active = state.sessions.find((s) => s.key === "a1b2c3d4e5f60718");
      const inactive = state.sessions.find((s) => s.key === "0011223344556677");
      expect(active?.active).toBe(true);
      expect(inactive?.active).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a missing state file as no sessions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-lav-empty-"));
    const config = configWith({
      WORKBENCH_LAVISH_URL: "https://lavish.example.com",
      LAVISH_AXI_STATE_DIR: dir,
      LAVISH_AXI_PORT: "1",
    });
    try {
      const state = await readLavishSessions(config);
      expect(state.configured).toBe(true);
      expect(state.sessions).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
