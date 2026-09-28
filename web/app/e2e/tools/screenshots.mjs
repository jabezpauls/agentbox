#!/usr/bin/env node
// The documentation's screenshots: every surface, light and dark.
//
//   node e2e/tools/screenshots.mjs <gate url> <out dir>
//
// Run it against a stack started with e2e/start-stack.mjs (a real
// code-server on E2E_CODE_PORT makes the editor's pictures real; see
// docs/workbench.md). It stages a believable box first — a project with a
// git history, two workspaces, an agent at work and one waiting, a dev
// server — then signs in once per theme and photographs each surface.
// MOCK_APPS=<json> stands in for the app API on a bridge without one.
import { chromium, devices } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { seed } from "./seed.mjs";

const [base, out] = process.argv.slice(2);
if (!base || !out) {
  console.error("usage: screenshots.mjs <gate url> <out dir>");
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const ip = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
const browser = await chromium.launch();

async function signIn(context, next = "/") {
  if (process.env.MOCK_APPS) {
    const body = fs.readFileSync(process.env.MOCK_APPS, "utf8");
    await context.route(/\/api\/apps$/, (route) => route.fulfill({ contentType: "application/json", body }));
  }
  const page = await context.newPage();
  await page.goto(`${base}/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Username").fill(process.env.E2E_USER ?? "e2e");
  await page.getByLabel("Password").fill(process.env.E2E_PASSWORD ?? "e2e-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.locator("nav.rail:visible, nav.bottombar:visible").first().waitFor();
  return page;
}

const rpc = (page, method, params) =>
  page.evaluate(
    async ({ method, params }) => {
      const res = await fetch("/api/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
      return (await res.json()).result;
    },
    { method, params },
  );

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// --- stage the box -------------------------------------------------------------

const setup = await browser.newContext({ extraHTTPHeaders: { "x-agentbox-client-ip": ip() } });
const stage = await signIn(setup);
const root = await stage.evaluate(async () => (await (await fetch("/api/health")).json()).workspaceRoot);
const project = fs.existsSync(path.join(root, "goofy-app")) ? path.join(root, "goofy-app") : seed(root);

const snapshot = await stage.evaluate(async () => (await fetch("/api/session")).json());
for (const w of snapshot.workspaces) await rpc(stage, "workspace.close", { workspace_id: w.workspace_id });

const transcript = [
  "\\033[1mClaude Code\\033[0m  ·  goofy-app",
  "",
  "> Put a goofy React page in my preview",
  "",
  "\\033[32mok\\033[0m  Scaffolded Vite + React in goofy-app",
  "\\033[32mok\\033[0m  Wrote src/App.tsx, src/Button.tsx",
  "\\033[32mok\\033[0m  agentbox-preview start -- npm run dev",
  "\\033[36m..\\033[0m  Waiting for the dev server on :5173",
  "",
  "   \\033[2mThe page is in your Preview dock.\\033[0m",
].join("\\n");
const a = await rpc(stage, "workspace.create", { cwd: project, label: "goofy-app", focus: true });
await rpc(stage, "tab.rename", { tab_id: a.tab.tab_id, label: "main" });
const agentPane = a.root_pane.pane_id;
await rpc(stage, "pane.send_input", { pane_id: agentPane, text: `clear; printf '%b\\n' '${transcript}'; sleep 86400`, keys: ["Enter"] });
await rpc(stage, "pane.rename", { pane_id: agentPane, label: "claude" });
await rpc(stage, "pane.report_agent", { pane_id: agentPane, source: "screenshots", agent: "claude", state: "working" });
const port = await freePort();
const split = await rpc(stage, "pane.split", { target_pane_id: agentPane, direction: "down", focus: false });
const serverPane = split?.pane?.pane_id ?? split?.pane_id;
if (serverPane) await rpc(stage, "pane.send_input", { pane_id: serverPane, text: `clear; python3 -m http.server ${port} --bind 127.0.0.1`, keys: ["Enter"] });
await rpc(stage, "tab.create", { workspace_id: a.workspace.workspace_id, cwd: project, label: "build", focus: false });
const b = await rpc(stage, "workspace.create", { cwd: path.join(root, "notes"), label: "docs-site", focus: false });
await rpc(stage, "pane.send_input", { pane_id: b.root_pane.pane_id, text: "clear; printf 'Should the plan ship behind a flag? (y/n) '; sleep 86400", keys: ["Enter"] });
await rpc(stage, "pane.rename", { pane_id: b.root_pane.pane_id, label: "codex" });
await rpc(stage, "pane.report_agent", { pane_id: b.root_pane.pane_id, source: "screenshots", agent: "codex", state: "blocked" });
await rpc(stage, "workspace.focus", { workspace_id: a.workspace.workspace_id });
await rpc(stage, "pane.focus", { pane_id: agentPane });
await setup.close();

// --- photograph it -------------------------------------------------------------

const settle = (page, ms = 900) => page.waitForTimeout(ms);
const shots = [];

for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
    deviceScaleFactor: 1,
    extraHTTPHeaders: { "x-agentbox-client-ip": ip() },
  });
  const page = await signIn(context);
  // The first listening port opens the dock once; start every picture without it.
  await settle(page, 2000);
  const closeDock = async () => {
    const close = page.getByRole("button", { name: "Close the dock" });
    if (await close.isVisible()) await close.click();
  };
  await closeDock();
  const go = async (route) => {
    await page.evaluate((r) => {
      window.history.pushState(null, "", r);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, route);
    await settle(page);
  };
  const shoot = async (name) => {
    // No hover state in the picture.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(150);
    const file = path.join(out, `${name}-${scheme}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  };

  await go("/");
  await settle(page, 1500);
  await shoot("home");

  await go("/workbench");
  await settle(page, 1500);
  await shoot("workbench");

  await go("/editor");
  await page.frameLocator("iframe.editor-frame").locator("body").waitFor();
  // A file open, the way "Open in editor" leaves it.
  await page.evaluate(async (file) => {
    await fetch("/api/editor/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: file, line: 2, wait: 30000 }) });
  }, path.join(project, "src", "App.tsx"));
  await settle(page, 4000);
  await shoot("editor");

  await go(`/files${project}`);
  await shoot("files");
  await go(`/files${project}/README.md`);
  await shoot("files-quick-look");
  await page.keyboard.press("Escape");

  await go("/apps");
  const first = page.locator(".apps-row-main").first();
  if (await first.count()) {
    await first.click();
    await settle(page);
  }
  await shoot("apps");

  await go("/system");
  await settle(page, 5000);
  await shoot("system");

  await go("/settings/account");
  await shoot("settings");

  await go("/");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("goofy");
  await settle(page);
  await shoot("palette");
  await page.keyboard.press("Escape");

  await go("/workbench");
  await page.getByRole("button", { name: "Dock" }).click();
  await settle(page, 2500);
  await shoot("dock");
  await closeDock();
  await context.close();
}

// A phone, light and dark.
for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({ ...devices["Pixel 7"], colorScheme: scheme, extraHTTPHeaders: { "x-agentbox-client-ip": ip() } });
  const page = await signIn(context);
  await page.waitForTimeout(1500);
  let file = path.join(out, `mobile-home-${scheme}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  await page.locator("nav.bottombar").getByRole("button", { name: /^More/ }).tap();
  await page.waitForTimeout(600);
  file = path.join(out, `mobile-more-${scheme}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  await context.close();
}

await browser.close();
for (const s of shots) console.log(s);
