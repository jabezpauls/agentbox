import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * The fidelity suite: real apps — a create-vite React app among them — served
 * under /a/<id>/ by the real gate and bridge, in Chromium, Firefox and WebKit.
 * It proves what the app model promises and what each engine does with it:
 * the page renders in the Preview panel, live reload works, images load,
 * storage and cookies behave, an app's own login works private and shared,
 * and taking sharing away cuts a viewer off.
 *
 * Needs the build (npm run build), herdr on PATH, openssl, and the fixture's
 * dependencies, installed once and kept between runs:
 *
 *   npm run fidelity:deps -w app      # npm ci in fidelity/fixtures/vite-react
 *   npm run fidelity -w app           # all three engines
 *
 * Firefox and WebKit need their browsers and system libraries; on a host that
 * lacks them, run inside the Playwright image (see docs/workbench.md).
 */
const PORT = Number(process.env.FIDELITY_PORT ?? 34443);
const GATE_PORT = Number(process.env.FIDELITY_GATE_PORT ?? 34920);
const BRIDGE_PORT = Number(process.env.FIDELITY_BRIDGE_PORT ?? 34820);
const WORKSPACES = process.env.FIDELITY_WORKSPACES ?? path.join(os.tmpdir(), `agentbox-fidelity-${GATE_PORT}`, "workspaces");

// Shared with the specs (and the stack), which read them from the environment.
process.env.FIDELITY_PORT = String(PORT);
process.env.FIDELITY_BRIDGE_PORT = String(BRIDGE_PORT);
process.env.FIDELITY_WORKSPACES = WORKSPACES;

export default defineConfig({
  testDir: "./fidelity",
  // A dev server's first compile, and three engines' worth of it.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html", { open: "never", outputFolder: "playwright-report-fidelity" }], ["list"]] : "list",
  outputDir: "test-results-fidelity",
  use: {
    baseURL: `https://localhost:${PORT}/`,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "node fidelity/stack.mjs",
    url: `http://127.0.0.1:${GATE_PORT}/login`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      FIDELITY_PORT: String(PORT),
      GATE_PORT: String(GATE_PORT),
      WORKBENCH_PORT: String(BRIDGE_PORT),
      E2E_CODE_PORT: String(GATE_PORT + 8),
      E2E_WORKSPACES: WORKSPACES,
    },
  },
});
