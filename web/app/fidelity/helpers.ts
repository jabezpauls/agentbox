import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));

export const BASE = `https://localhost:${process.env.FIDELITY_PORT}`;
/** The bridge, as the in-sandbox CLIs reach it: directly, never through the gate. */
export const BRIDGE = `http://127.0.0.1:${process.env.FIDELITY_BRIDGE_PORT}`;
export const WORKSPACES = process.env.FIDELITY_WORKSPACES as string;
export const USER = process.env.E2E_USER ?? "e2e";
export const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-password-1";
export const PREVIEW_CLI = path.resolve(here, "../../../images/workspace/agentbox-preview");
export const VITE_FIXTURE = path.join(here, "fixtures", "vite-react");
export const TINY_APPS = path.join(here, "fixtures", "tiny-apps.mjs");

/**
 * The suite's tests, each in a context that is already signed in: the owner
 * signs in once per engine, through the real page, and every test starts from
 * that session (sign-in is rate-limited, as it should be).
 */
export const test = base.extend<object, { ownerState: string }>({
  ownerState: [
    async ({ browser }, use, workerInfo) => {
      const file = path.join(workerInfo.project.outputDir, `owner-${workerInfo.project.name}.json`);
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/login?next=${encodeURIComponent("/workbench")}`);
      await page.getByLabel("Username").fill(USER);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(`${BASE}/workbench`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await ctx.storageState({ path: file });
      await ctx.close();
      await use(file);
    },
    { scope: "worker" },
  ],
  storageState: ({ ownerState }, use) => use(ownerState),
});

/** Open the Workbench, signed in. */
export async function signIn(page: Page): Promise<void> {
  await page.goto(`${BASE}/workbench`);
  await expect(page).toHaveURL(`${BASE}/workbench`);
}

/** Call the gate or the bridge from inside the signed-in page, as the app does. */
export async function api(page: Page, method: string, url: string, data?: object): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ({ method, url, data }) => {
      const res = await fetch(url, {
        method,
        headers: data === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
    },
    { method, url, data },
  );
}

/** Make an app of a port, as the owner does; returns its id. */
export async function makeApp(page: Page, port: number, name: string): Promise<string> {
  const res = await api(page, "POST", "/_gate/apps", { port, name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Wait until something accepts connections on the port, on either loopback. */
export async function waitPort(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect(port, host, () => {
        s.end();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
  while (Date.now() < deadline) {
    if ((await tryHost("127.0.0.1")) || (await tryHost("::1"))) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`nothing came up on port ${port}`);
}

/**
 * A copy of the create-vite fixture in the stack's workspace, where a server
 * counts as the owner's (its process runs under the workspace root). Its
 * dependencies are copied from the fixture's own install: each copy needs a
 * node_modules of its own, since Vite keeps its dependency cache there.
 */
export function copyVite(name: string): string {
  if (!fs.existsSync(path.join(VITE_FIXTURE, "node_modules", "vite"))) {
    throw new Error("the fixture's dependencies are not installed: run `npm run fidelity:deps -w app` first");
  }
  const dir = path.join(WORKSPACES, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(VITE_FIXTURE, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.vite`) });
  return dir;
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run agentbox-preview as an agent in the sandbox runs it. */
export function preview(args: string[], cwd: string): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [PREVIEW_CLI, ...args], { cwd, env: { ...process.env, AGENTBOX_PREVIEW_URL: BRIDGE } }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

/** The id in agentbox-preview's output. */
export function idFrom(run: Run): string {
  const m = /id: ([a-z2-7]{26})/.exec(run.stdout);
  if (!m) throw new Error(`no app id in: ${run.stdout} ${run.stderr}`);
  return m[1] as string;
}

const children: ChildProcess[] = [];

/** Start a server in the workspace, as a person does in a terminal; stopped when the suite ends. */
export function startServer(command: string, args: string[], cwd: string, env: Record<string, string> = {}): ChildProcess {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: "ignore", detached: true });
  children.push(child);
  return child;
}

export function stopServers(): void {
  for (const c of children.splice(0)) {
    try {
      if (c.pid) process.kill(-c.pid, "SIGTERM");
    } catch {
      // gone
    }
  }
}

/** A fresh browser context with nobody signed in: a visitor with the link. */
let visitors = 0;
export function visitor(browser: Browser): Promise<BrowserContext> {
  // Stated outright: a context made in a test otherwise starts from the
  // suite's signed-in state. And a client of its own, as a visitor is: the
  // gate's limits count per address, and the stack's proxy is loopback, which
  // the gate believes about the address it names (see e2e/start-stack.mjs).
  visitors += 1;
  return browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { "X-Agentbox-Client-IP": `198.51.100.${(process.pid + visitors) % 250}` },
  });
}

/**
 * The right-hand panel open on Preview. The panel may open by itself while the
 * page settles (the first server it sees opens it), so this looks again rather
 * than toggling blind.
 */
export async function showPreview(page: Page): Promise<void> {
  const tab = page.getByRole("tab", { name: "Preview" });
  await expect(page.getByRole("button", { name: "Toggle inspector" })).toBeVisible();
  for (let i = 0; i < 5 && !(await tab.isVisible()); i++) {
    await page.getByRole("button", { name: "Toggle inspector" }).click();
    await tab.waitFor({ state: "visible", timeout: 2_000 }).catch(() => {});
  }
  await tab.click();
}

/** Show an app in the Preview panel by picking it from the list. */
export async function pickApp(page: Page, name: string): Promise<void> {
  await showPreview(page);
  await page.getByRole("list", { name: "Apps" }).getByRole("button", { name: new RegExp(name) }).click();
}

/** The Preview panel's frame. */
export function previewFrame(page: Page) {
  return page.frameLocator("iframe.prev-frame");
}
