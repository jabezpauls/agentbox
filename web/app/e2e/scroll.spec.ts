import { expect, test, type Cookie } from "@playwright/test";
import { clientIp } from "./gate.ts";
import { resume, sharedSession } from "./session.ts";
import { closeAllWorkspaces, paneIds, runCommand, runFromPalette, termText, waitForOutput } from "./helpers.ts";

/**
 * The mouse wheel over a terminal scrolls herdr's scrollback for the pane:
 * the screen shows earlier output, a marker says how far back it is, and
 * typing (or the button) returns to the live screen.
 */

let cookies: Cookie[] = [];
test.beforeAll(async ({ browser }) => {
  cookies = await sharedSession(browser);
});
test.beforeEach(async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ "x-agentbox-client-ip": clientIp() });
});

test("the wheel scrolls a pane's history and a key returns to live", async ({ page }) => {
  await resume(page, cookies, "/workbench");
  await closeAllWorkspaces(page);
  await expect.poll(async () => (await paneIds(page)).length).toBe(0);
  await runFromPalette(page, "New workspace");
  await page.getByRole("button", { name: /use this folder/i }).click();
  await expect.poll(async () => (await paneIds(page)).length).toBe(1);
  const pane = (await paneIds(page))[0]!;

  await runCommand(page, "for i in $(seq 1 500); do echo row-$i; done; echo ROWS-DONE");
  await waitForOutput(page, "ROWS-DONE");
  const shows = async (re: RegExp) => re.test(await termText(page, pane));
  expect(await shows(/^row-100 *$/m)).toBe(false);

  const screen = page.locator(".term-host .xterm-screen").first();
  const box = (await screen.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Notch by notch, as a mouse wheel sends it, until row 100 is on screen.
  await expect
    .poll(
      async () => {
        await page.mouse.wheel(0, -2000);
        return shows(/^row-100 *$/m);
      },
      { timeout: 20_000, message: "the wheel never brought row 100 into view" },
    )
    .toBe(true);
  const live = page.getByRole("button", { name: /jump to live/i });
  await expect(live).toBeVisible();
  await expect(page.locator(".term-scrollbar.is-back")).toBeVisible();

  // The button goes back to live.
  await live.click();
  await expect.poll(() => shows(/ROWS-DONE/)).toBe(true);
  await expect(live).toBeHidden();

  // Scroll back again; a keypress returns to live, and reaches the shell.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -1000);
  await expect(live).toBeVisible();
  await expect.poll(() => shows(/ROWS-DONE/)).toBe(false);
  await page.keyboard.type("echo BACK-$((40+2))");
  await page.keyboard.press("Enter");
  await waitForOutput(page, "BACK-42");
  await expect(live).toBeHidden();
});
