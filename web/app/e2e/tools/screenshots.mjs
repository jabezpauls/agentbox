#!/usr/bin/env node
// The documentation's screenshots: every surface, light and dark.
//
//   e2e/tools/clean-box.sh up agentbox/workspace:<tag>
//   node e2e/tools/screenshots.mjs http://127.0.0.1:27950 ../../docs/images
//   e2e/tools/clean-box.sh down
//
// The pictures go into a public repository, so they are taken of the clean
// box clean-box.sh starts — a sandbox container with fixture projects, user
// `coder`, host `agentbox` — and never of a developer's machine. The script
// checks before it takes anything: the box's paths, who is signed in, and a
// process table and a set of listening ports small enough to be a sandbox's
// and with nothing of a desktop in them. Anything else is refused, with what
// gave it away.
//
// It then stages a believable box — two workspaces, an agent at work and one
// waiting, the project's dev server — signs in once per theme and
// photographs each surface. The project's dev server is made an app and
// shared, as the owner would, so Home, Apps and the dock show a real one.
import { chromium, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const [base, out] = process.argv.slice(2);
if (!base || !out) {
  console.error("usage: screenshots.mjs <gate url> <out dir>");
  process.exit(2);
}
const USER = process.env.CLEAN_BOX_USER ?? "coder";
const PASSWORD = process.env.CLEAN_BOX_PASSWORD ?? "coder-password-1";
const WORKSPACE = "/workspace";
const PROJECT = `${WORKSPACE}/goofy-app`;
/** The project's "dev server": its built page, on Vite's port. */
const DEV_PORT = 5173;

const ip = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
const browser = await chromium.launch();

async function signIn(context, next = "/") {
  if (process.env.MOCK_APPS) {
    const body = fs.readFileSync(process.env.MOCK_APPS, "utf8");
    await context.route(/\/api\/apps$/, (route) => route.fulfill({ contentType: "application/json", body }));
  }
  const page = await context.newPage();
  await page.goto(`${base}/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Username").fill(USER);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.locator("nav.rail:visible, nav.bottombar:visible").first().waitFor();
  return page;
}

const getJSON = (page, url) => page.evaluate(async (u) => (await fetch(u)).json(), url);

const rpc = (page, method, params) =>
  page.evaluate(
    async ({ method, params }) => {
      const res = await fetch("/api/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
      return (await res.json()).result;
    },
    { method, params },
  );

// --- is this a clean box? --------------------------------------------------------

/** What a desktop has running and a sandbox does not. */
const DESKTOP = /\b(systemd|Xorg|Xwayland|kwin\w*|gnome-\w+|plasma\w*|pipewire|pulseaudio|wireplumber|dbus-daemon|sshd|dockerd|containerd|firefox|chrome|slack|Code)\b/;

async function requireCleanBox(page, stage) {
  const problems = [];
  const health = await getJSON(page, "/api/health");
  if (health.workspaceRoot !== WORKSPACE) problems.push(`the workspace is ${health.workspaceRoot}, not ${WORKSPACE}`);
  if (health.homeRoot !== `/home/${USER}`) problems.push(`home is ${health.homeRoot}, not /home/${USER}`);
  const who = await getJSON(page, "/_gate/session");
  if (who.user !== USER) problems.push(`signed in as ${who.user}, not ${USER}`);
  const system = await getJSON(page, "/api/system");
  if (system.sandbox.processes > 80) problems.push(`${system.sandbox.processes} processes: that is a whole machine, not a sandbox`);
  for (const p of system.processes) {
    if (new RegExp(`/home/(?!${USER}\\b)|/Users/`).test(p.command)) problems.push(`a process runs from someone's home: ${p.command}`);
    else if (DESKTOP.test(p.command) || DESKTOP.test(p.name)) problems.push(`a desktop's process is running: ${p.name}`);
  }
  // agentbox's own ports aside (the editor's windows open a few), a sandbox
  // listens on its dev server and little else.
  const ports = (await getJSON(page, "/api/ports")).filter((p) => !p.system);
  if (ports.length > 4) problems.push(`${ports.length} ports are listening (${ports.map((p) => p.port).join(", ")}): a machine's, not a sandbox's`);
  if (stage === "staged") {
    // Every user@host a terminal shows (pane titles above all) is the box's.
    const snapshot = JSON.stringify(await getJSON(page, "/api/session"));
    for (const [id] of snapshot.matchAll(/\b[a-z_][a-z0-9_-]*@[a-z0-9][a-z0-9.-]*\b/gi)) {
      if (id !== `${USER}@agentbox`) problems.push(`a terminal names ${id}`);
    }
  }
  if (problems.length) {
    console.error(`Refusing to take screenshots: ${base} is not a clean box.`);
    for (const p of [...new Set(problems)]) console.error(`  - ${p}`);
    console.error("Start one with e2e/tools/clean-box.sh up, and point this at the address it prints.");
    await browser.close();
    process.exit(1);
  }
}

// --- stage the box -------------------------------------------------------------

fs.mkdirSync(out, { recursive: true });
const setup = await browser.newContext({ extraHTTPHeaders: { "x-agentbox-client-ip": ip() } });
const stage = await signIn(setup);
await requireCleanBox(stage, "fresh");
const listing = await stage.evaluate(async (p) => (await fetch(`/api/files/list?path=${encodeURIComponent(p)}`)).status, PROJECT);
if (listing !== 200) {
  console.error(`${PROJECT} is not there: the clean box seeds it (e2e/tools/seed.mjs).`);
  process.exit(1);
}
// A short sessions list in Settings: end every other session.
await stage.evaluate(() => fetch("/_gate/sessions?others=1", { method: "DELETE" }));

const snapshot = await getJSON(stage, "/api/session");
for (const w of snapshot.workspaces) await rpc(stage, "workspace.close", { workspace_id: w.workspace_id });

const transcript = [
  "\\033[1mClaude Code\\033[0m  ·  goofy-app",
  "",
  "> Put a goofy React page in my preview",
  "",
  "\\033[32mok\\033[0m  Scaffolded Vite + React in goofy-app",
  "\\033[32mok\\033[0m  Wrote src/App.tsx, src/Button.tsx",
  "\\033[32mok\\033[0m  agentbox-preview start -- npm run dev",
  `\\033[32mok\\033[0m  The dev server is up on :${DEV_PORT}`,
  "",
  "   \\033[2mThe page is in your Preview dock.\\033[0m",
].join("\\n");
const a = await rpc(stage, "workspace.create", { cwd: PROJECT, label: "goofy-app", focus: true });
await rpc(stage, "tab.rename", { tab_id: a.tab.tab_id, label: "main" });
const agentPane = a.root_pane.pane_id;
await rpc(stage, "pane.send_input", { pane_id: agentPane, text: `clear; printf '%b\\n' '${transcript}'; sleep 86400`, keys: ["Enter"] });
await rpc(stage, "pane.rename", { pane_id: agentPane, label: "claude" });
await rpc(stage, "pane.report_agent", { pane_id: agentPane, source: "screenshots", agent: "claude", state: "working" });
const split = await rpc(stage, "pane.split", { target_pane_id: agentPane, direction: "down", focus: false });
const serverPane = split?.pane?.pane_id ?? split?.pane_id;
if (serverPane) {
  await rpc(stage, "pane.send_input", {
    pane_id: serverPane,
    text: `clear; python3 -m http.server ${DEV_PORT} --bind 127.0.0.1 --directory dist`,
    keys: ["Enter"],
  });
  await rpc(stage, "pane.rename", { pane_id: serverPane, label: "dev server" });
}
// The dev server as an app, shared by link for a few days.
await stage.waitForTimeout(1500);
const made = await stage.evaluate(async (port) => {
  const res = await fetch("/_gate/apps", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ port, name: "goofy" }) });
  const app = await res.json();
  await fetch(`/_gate/apps/${app.id}/visibility`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "link", expiresIn: 5 * 86400 }),
  });
  return app.id;
}, DEV_PORT);
if (!made) console.warn("could not make an app of the dev server");
await rpc(stage, "tab.create", { workspace_id: a.workspace.workspace_id, cwd: PROJECT, label: "build", focus: false });
const b = await rpc(stage, "workspace.create", { cwd: `${WORKSPACE}/notes`, label: "docs-site", focus: false });
await rpc(stage, "pane.send_input", { pane_id: b.root_pane.pane_id, text: "clear; printf 'Should the plan ship behind a flag? (y/n) '; sleep 86400", keys: ["Enter"] });
await rpc(stage, "pane.rename", { pane_id: b.root_pane.pane_id, label: "codex" });
await rpc(stage, "pane.report_agent", { pane_id: b.root_pane.pane_id, source: "screenshots", agent: "codex", state: "blocked" });
await rpc(stage, "workspace.focus", { workspace_id: a.workspace.workspace_id });
await rpc(stage, "pane.focus", { pane_id: agentPane });
await stage.waitForTimeout(1500);
await requireCleanBox(stage, "staged");
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
  // One session in Settings: this one.
  await page.evaluate(() => fetch("/_gate/sessions?others=1", { method: "DELETE" }));
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

  // The editor, the way "Open in editor" leaves it, in the app's theme.
  await go(`/files${PROJECT}/src/App.tsx`);
  const look = page.getByRole("dialog", { name: /Quick look/ });
  await look.getByRole("button", { name: "Open in editor" }).click();
  const editor = page.frameLocator("iframe.editor-frame");
  await editor.locator('.tab[aria-label^="App.tsx"], .tab:has-text("App.tsx")').first().waitFor({ timeout: 90_000 });
  const want = scheme === "dark" ? /\bvs-dark\b/ : /\bvs\b(?!-)/;
  for (let i = 0; i < 100 && !want.test((await editor.locator(".monaco-workbench").first().getAttribute("class")) ?? ""); i++) await settle(page, 100);
  await settle(page, 2500);
  await shoot("editor");

  await go(`/files${PROJECT}`);
  await shoot("files");
  await go(`/files${PROJECT}/README.md`);
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

  // The dock beside the Workbench, showing the project's app.
  await go("/workbench");
  await go("/apps");
  await page.locator(".apps-list li", { hasText: "goofy" }).getByRole("button", { name: "Preview" }).first().click();
  await go("/workbench");
  if (!(await page.getByRole("complementary", { name: "Dock" }).isVisible())) await page.getByRole("button", { name: "Dock" }).click();
  await page
    .frameLocator(".dock iframe")
    .first()
    .getByRole("heading", { name: "Hello from goofy-app" })
    .waitFor({ timeout: 20_000 })
    .catch(() => console.warn("the preview did not show the page"));
  await settle(page, 1500);
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
