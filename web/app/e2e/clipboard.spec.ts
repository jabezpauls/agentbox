import { expect, test, type Cookie, type Page } from "@playwright/test";
import { clientIp } from "./gate.ts";
import { resume, sharedSession } from "./session.ts";
import { closeAllWorkspaces, paneIds, runCommand, runFromPalette, termText, waitForOutput } from "./helpers.ts";

/**
 * Copy and paste in the Workbench's terminals: selecting and Ctrl+Shift+C,
 * Ctrl+Shift+V, the right-click menu, copy-on-select as a setting, and
 * OSC 52 from a program in the pane.
 */

test.describe.configure({ mode: "serial" });
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

let cookies: Cookie[] = [];
test.beforeAll(async ({ browser }) => {
  cookies = await sharedSession(browser);
});
test.beforeEach(async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ "x-agentbox-client-ip": clientIp() });
});

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const setClipboard = (page: Page, text: string) => page.evaluate((t) => navigator.clipboard.writeText(t), text);

/** A fresh workspace with one shell, focused. */
async function freshShell(page: Page, copyOnSelect: boolean): Promise<string> {
  await page.addInitScript((on) => localStorage.setItem("agentbox.terminalCopyOnSelect", on ? "on" : "off"), copyOnSelect);
  await resume(page, cookies, "/workbench");
  await closeAllWorkspaces(page);
  await expect.poll(async () => (await paneIds(page)).length).toBe(0);
  await runFromPalette(page, "New workspace");
  await page.getByRole("button", { name: /use this folder/i }).click();
  await expect.poll(async () => (await paneIds(page)).length).toBe(1);
  return (await paneIds(page))[0]!;
}

/** Triple-click the terminal row showing exactly `line`, selecting it. */
async function selectLine(page: Page, pane: string, line: string): Promise<void> {
  const rows = (await termText(page, pane)).split("\n");
  const row = rows.findIndex((r) => r.trim() === line);
  expect(row, `a row showing ${line}`).toBeGreaterThanOrEqual(0);
  const box = (await page.locator(".term-host .xterm-screen").first().boundingBox())!;
  const y = box.y + ((row + 0.5) * box.height) / rows.length;
  await page.mouse.click(box.x + 20, y, { clickCount: 3 });
}

test("a selection is copied with Ctrl+Shift+C, and only then when copy-on-select is off", async ({ page }) => {
  const pane = await freshShell(page, false);
  await runCommand(page, "echo CLIP_$((6*7))");
  await waitForOutput(page, "CLIP_42");
  await setClipboard(page, "before");

  await selectLine(page, pane, "CLIP_42");
  await page.waitForTimeout(200);
  expect(await clipboard(page)).toBe("before");

  await page.keyboard.press("Control+Shift+C");
  await expect.poll(() => clipboard(page)).toContain("CLIP_42");
  // The shell got no ^C out of it: the line it was on is still there.
  expect(await termText(page, pane)).not.toContain("^C");
});

test("copy-on-select copies as the mouse lets go", async ({ page }) => {
  const pane = await freshShell(page, true);
  await runCommand(page, "echo SEL_$((6*7))");
  await waitForOutput(page, "SEL_42");
  await setClipboard(page, "before");
  await selectLine(page, pane, "SEL_42");
  await expect.poll(() => clipboard(page)).toContain("SEL_42");
});

test("Ctrl+Shift+V and the right-click menu paste into the shell", async ({ page }) => {
  await freshShell(page, false);
  await page.locator(".term-host").first().click();

  await setClipboard(page, "echo PASTE_$((5*5))");
  await page.keyboard.press("Control+Shift+V");
  // The paste lands on the command line first (reading the clipboard is async).
  await waitForOutput(page, "echo PASTE_$((5*5))");
  await page.keyboard.press("Enter");
  await waitForOutput(page, "PASTE_25");

  await setClipboard(page, "echo MENU_$((4*4))");
  await page.locator(".term-host").first().click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Terminal" });
  await expect(menu).toBeVisible();
  // Nothing is selected, so there is nothing to copy.
  await expect(menu.getByRole("menuitem", { name: /Copy/ })).toBeDisabled();
  await menu.getByRole("menuitem", { name: /Paste/ }).click();
  await expect(menu).toBeHidden();
  await waitForOutput(page, "echo MENU_$((4*4))");
  await page.keyboard.press("Enter");
  await waitForOutput(page, "MENU_16");
});

// herdr 0.9.1 renders each pane itself and keeps an OSC 52 to its own
// clients: nothing of it reaches `herdr terminal session control`, so the app
// never sees one (checked against the raw control stream). The app handles
// OSC 52 (see terminal/clipboard.ts); this runs once herdr passes it on.
test.fixme("a program's OSC 52 copy reaches the clipboard", async ({ page }) => {
  await freshShell(page, false);
  await setClipboard(page, "before");
  await runCommand(page, `printf '\\033]52;c;%s\\007' "$(printf OSC_COPY | base64)"`);
  await expect.poll(() => clipboard(page), { timeout: 5_000 }).toBe("OSC_COPY");
});
