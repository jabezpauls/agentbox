import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect, test, type Cookie, type Page } from "@playwright/test";
import { GATE, signIn } from "./gate.ts";
import { resume, sharedSession } from "./session.ts";
import { paneIds, runCommand, runFromPalette, termText, waitForOutput } from "./helpers.ts";

/**
 * The app as one app: J1 (arrive on Home), J5 (move between surfaces and
 * nothing reloads — the editor keeps what was typed, the terminals keep
 * their sockets), deep links that survive a reload and the back button, and
 * the palette over everything.
 */

test.describe.configure({ mode: "serial" });

let client = 0;
let cookies: Cookie[] = [];
test.beforeAll(async ({ browser }) => {
  cookies = await sharedSession(browser, "203.0.113.170");
});
test.beforeEach(async ({ page }) => {
  client += 1;
  await page.context().setExtraHTTPHeaders({ "x-agentbox-client-ip": `203.0.113.${170 + client}` });
});

async function workspaceRoot(page: Page): Promise<string> {
  return page.evaluate(async () => ((await (await fetch("/api/health")).json()) as { workspaceRoot: string }).workspaceRoot);
}

const filesRoute = (abs: string) => `/files${abs.split("/").map(encodeURIComponent).join("/")}`;

/** The surface that is showing. */
const surface = (page: Page, id: string) => page.locator(`section.surface[data-surface="${id}"][data-active]`);

// A stand-in for code-server on the port the gate forwards /vscode/ to: a
// page with a text area, which is all "the editor keeps what you typed"
// needs. (docs/workbench.md describes checking the same against the real
// code-server in the compose stack.)
const codePort = Number(process.env.E2E_CODE_PORT ?? 7808);
let editor: http.Server | null = null;
test.beforeAll(async () => {
  editor = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><title>Editor stand-in</title><textarea id="doc" aria-label="Document" style="width:90%;height:80vh"></textarea>');
  });
  await new Promise<void>((r) => editor!.listen(codePort, "127.0.0.1", r));
});
test.afterAll(async () => {
  await new Promise<void>((r) => (editor ? editor.close(() => r()) : r()));
});

test("J1: signing in lands on Home, which says what needs you and what is in the box", async ({ page }) => {
  await signIn(page);
  await expect(surface(page, "home")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening), e2e$/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /need(s)? you/i })).toBeVisible();
  // The workspace's top-level folders are the projects.
  await expect(page.getByRole("article", { name: "demo" })).toBeVisible();
  await expect(page.getByRole("article", { name: "other" })).toBeVisible();
  // And the box itself.
  await expect(page.getByRole("meter", { name: "CPU" })).toBeVisible();
  await expect(page.getByRole("meter", { name: "Disk" })).toBeVisible();
  await expect(page).toHaveTitle(/Home · agentbox/);
});

test("project cards: a name with spaces labels its card, and the actions line up at the foot", async ({ page }) => {
  await resume(page, cookies);
  const root = await workspaceRoot(page);
  fs.mkdirSync(path.join(root, "two words"), { recursive: true });
  fs.writeFileSync(path.join(root, "two words", "README.md"), "# Two words\n");
  await page.reload();
  const card = page.getByRole("article", { name: "two words" });
  await expect(card).toBeVisible();

  // Every card's action row sits the same distance from its card's foot,
  // however much each card has above it.
  const gaps = await page.locator("article.project-card").evaluateAll((cards) =>
    cards.map((c) => Math.round(c.getBoundingClientRect().bottom - c.querySelector(".card-actions")!.getBoundingClientRect().bottom)),
  );
  expect(gaps.length).toBeGreaterThan(1);
  expect(new Set(gaps).size).toBe(1);
  fs.rmSync(path.join(root, "two words"), { recursive: true, force: true });
});

test("J1: a link into the app survives the sign-in on the way", async ({ page }) => {
  await signIn(page, "/settings/cli");
  await expect(surface(page, "settings")).toBeVisible();
  await expect(page.getByText(`curl -fsSL ${GATE}/cli/install | sh`)).toBeVisible();
});

test("J5: moving between surfaces reloads nothing — the editor keeps its text, the terminals their sockets", async ({ page }) => {
  const terminalSockets: string[] = [];
  page.on("websocket", (ws) => {
    if (ws.url().includes("/ws/terminal")) terminalSockets.push(ws.url());
  });
  await resume(page, cookies, "/workbench");
  await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));

  await test.step("a terminal is running in the Workbench", async () => {
    if ((await paneIds(page)).length === 0) {
      await runFromPalette(page, "New workspace");
      await page.getByRole("button", { name: /use this folder/i }).click();
    }
    await expect.poll(async () => (await paneIds(page)).length).toBeGreaterThan(0);
    await runCommand(page, "echo J5_$((6*7))");
    await waitForOutput(page, "J5_42");
  });
  const socketsBefore = terminalSockets.length;
  const panesBefore = await paneIds(page);

  await test.step("text typed in the editor", async () => {
    await page.getByRole("link", { name: "Editor" }).click();
    await expect(surface(page, "editor")).toBeVisible();
    await expect(page).toHaveURL(/\/editor$/);
    const doc = page.frameLocator("iframe.editor-frame").locator("#doc");
    await doc.fill("kept alive");
  });

  await test.step("is still there after going around every surface", async () => {
    await page.getByRole("link", { name: "Files" }).click();
    await expect(surface(page, "files")).toBeVisible();
    await page.getByRole("link", { name: "Home" }).click();
    await expect(surface(page, "home")).toBeVisible();
    // ⌃⌥ + a number goes to a surface from anywhere.
    await page.keyboard.press("Control+Alt+6");
    await expect(surface(page, "system")).toBeVisible();
    await page.keyboard.press("Control+Alt+3");
    await expect(surface(page, "editor")).toBeVisible();
    await expect(page.frameLocator("iframe.editor-frame").locator("#doc")).toHaveValue("kept alive");
    // One frame, built once.
    await expect(page.locator("iframe.editor-frame")).toHaveCount(1);
  });

  await test.step("the chords work from inside the editor's frame", async () => {
    await page.frameLocator("iframe.editor-frame").locator("#doc").focus();
    await page.keyboard.press("Control+Alt+4");
    await expect(surface(page, "files")).toBeVisible();
  });

  await test.step("and the terminals never reconnected", async () => {
    await page.getByRole("link", { name: "Workbench" }).click();
    await expect(surface(page, "workbench")).toBeVisible();
    expect(await paneIds(page)).toEqual(panesBefore);
    expect(terminalSockets.length).toBe(socketsBefore);
    await runCommand(page, "echo J5_BACK_$((7*6))");
    const pane = await waitForOutput(page, "J5_BACK_42");
    expect(await termText(page, pane)).toContain("J5_42");
    await expect(page.locator(".term-notice")).toHaveCount(0);
    // No page load happened at any point.
    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
  });

  await test.step("hidden surfaces are out of reach", async () => {
    const hidden = page.locator('section.surface[data-surface="editor"]');
    await expect(hidden).toHaveAttribute("aria-hidden", "true");
    expect(await hidden.evaluate((el) => el.hasAttribute("inert"))).toBe(true);
  });

  // Leave herdr as it was found: the Workbench spec starts from nothing open.
  await page.evaluate(async () => {
    const session = (await (await fetch("/api/session")).json()) as { workspaces: { workspace_id: string }[] };
    for (const w of session.workspaces) {
      await fetch("/api/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "workspace.close", params: { workspace_id: w.workspace_id } }),
      });
    }
  });
});

test("every route is a deep link that survives a reload, and back and forward", async ({ page }) => {
  await resume(page, cookies);
  const root = await workspaceRoot(page);
  // Each route, the surface it shows, and something only that view says (the
  // editor is its frame alone).
  const routes: [string, string, RegExp | null][] = [
    [filesRoute(path.join(root, "demo")), "files", /demo/],
    ["/apps", "apps", /Apps/],
    ["/system", "system", /System/],
    ["/system/monitor", "system", /System/],
    ["/settings/cli", "settings", /Devices & CLI/],
    ["/settings/appearance", "settings", /Appearance/],
    ["/workbench", "workbench", /Workbench/],
    ["/editor", "editor", null],
    ["/", "home", /Good/],
  ];
  for (const [url, id, title] of routes) {
    await page.goto(url);
    await expect(surface(page, id)).toBeVisible();
    await page.reload();
    await expect(surface(page, id)).toBeVisible();
    await expect(page).toHaveURL(`${GATE}${url}`);
    if (title) await expect(surface(page, id)).toContainText(title);
    else await expect(surface(page, id).locator("iframe.editor-frame")).toBeVisible();
  }

  await page.goto("/");
  await page.getByRole("link", { name: "Files" }).click();
  await expect(surface(page, "files")).toBeVisible();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(surface(page, "settings")).toBeVisible();
  await page.goBack();
  await expect(surface(page, "files")).toBeVisible();
  await page.goBack();
  await expect(surface(page, "home")).toBeVisible();
  await page.goForward();
  await expect(surface(page, "files")).toBeVisible();
});

test("the palette finds surfaces, projects, files and commands", async ({ page }) => {
  await resume(page, cookies);
  const root = await workspaceRoot(page);
  fs.writeFileSync(path.join(root, "demo", "findme-palette.md"), "# Found\n");

  await expect(surface(page, "home")).toBeVisible();
  const open = async () => {
    await page.keyboard.press("Control+k");
    await expect(page.getByLabel("Command palette query")).toBeFocused();
  };

  await open();
  await page.keyboard.type("demo");
  await expect(page.getByRole("group", { name: "Projects" }).getByRole("option", { name: /^demo/ })).toBeVisible();
  await page.getByRole("group", { name: "Projects" }).getByRole("option", { name: /^demo/ }).click();
  await expect(page).toHaveURL(new RegExp(`${filesRoute(path.join(root, "demo")).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));

  await open();
  await page.keyboard.type("system");
  await page.keyboard.press("Enter");
  await expect(surface(page, "system")).toBeVisible();

  await open();
  await page.keyboard.type("findme");
  const hit = page.getByRole("group", { name: "Files" }).getByRole("option", { name: /findme-palette\.md/ });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page.getByRole("dialog", { name: /Quick look: findme-palette\.md/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await open();
  await page.keyboard.type("settings: devices");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings\/cli$/);

  // ⌃⌥K opens it too; Escape closes it.
  await page.keyboard.press("Control+Alt+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
});

test("the dock opens beside any surface and remembers itself per surface", async ({ page }) => {
  await resume(page, cookies, "/system");
  await expect(surface(page, "system")).toBeVisible();
  const dock = page.getByRole("complementary", { name: "Dock" });
  await page.keyboard.press("Control+Alt+d");
  await expect(dock).toBeVisible();
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true");
  // Closed on Settings…
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Close the dock" }).click();
  await expect(dock).toBeHidden();
  // …still open on System.
  await page.getByRole("link", { name: "System" }).click();
  await expect(dock).toBeVisible();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(dock).toBeHidden();
});
