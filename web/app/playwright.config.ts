import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.WORKBENCH_PORT ?? 7800);

/**
 * The end-to-end suite runs against the real stack: `e2e/start-stack.mjs`
 * launches a herdr server on a throwaway socket and the compiled bridge
 * serving the built app. Chromium only — this is testing the Workbench, not
 * browser coverage, and a headless Chromium is what CI can afford.
 */
export default defineConfig({
  testDir: "./e2e",
  // Terminals are real processes: a shell prompt can take a moment to appear.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}/workbench/`,
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/start-stack.mjs",
    url: `http://127.0.0.1:${PORT}/workbench/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
