import { expect, test } from "@playwright/test";
import { paneIds, runCommand, runFromPalette, termText, waitForOutput } from "./helpers.ts";

// One session, run in order: each step builds on the workspace the previous
// one created, the way a person uses the app. Splitting these into independent
// tests would mean creating a workspace four times for no extra coverage.
test.describe.configure({ mode: "serial" });

test("the Workbench drives herdr end to end", async ({ page }) => {
  await page.goto("./");

  await test.step("it starts empty and connected", async () => {
    await expect(page.getByText("Select a pane")).toBeVisible();
    await expect(page.getByText("No workspaces yet.")).toBeVisible();
    // The connection pill reports the live herdr the stack started.
    await expect(page.locator(".conn-pill.is-open")).toBeVisible();
  });

  await test.step("a workspace created from the palette gets a live terminal", async () => {
    await runFromPalette(page, "New workspace");
    await expect(page.getByRole("dialog", { name: "New workspace" })).toBeVisible();

    await page.getByRole("button", { name: /use this folder/i }).click();
    await expect(page.getByRole("dialog", { name: "New workspace" })).toBeHidden();

    await expect.poll(async () => (await paneIds(page)).length).toBe(1);
    await expect(page.locator(".pane-cell")).toHaveCount(1);
  });

  await test.step("a command typed into a pane runs in a real shell", async () => {
    await runCommand(page, "echo E2E_$((6*7))");
    const pane = await waitForOutput(page, "E2E_42");
    expect(await termText(page, pane)).toContain("E2E_42");
  });

  await test.step("the prefix keymap splits the pane", async () => {
    await page.locator(".term-host").first().click();
    await page.keyboard.press("Control+b");
    await page.keyboard.press("v");

    await expect(page.locator(".pane-cell")).toHaveCount(2);
    await expect.poll(async () => (await paneIds(page)).length).toBe(2);
  });

  await test.step("the theme switch reaches the document", async () => {
    const html = page.locator("html");
    const before = await html.getAttribute("data-theme");
    // The control cycles system → light → dark; press until dark is stamped.
    for (let i = 0; i < 3 && (await html.getAttribute("data-theme")) !== "dark"; i++) {
      await page.getByRole("button", { name: /theme$/i }).click();
    }
    await expect(html).toHaveAttribute("data-theme", "dark");
    expect(before).not.toBe("dark");
  });

  await test.step("a server started in a pane can be previewed", async () => {
    await runCommand(page, "python3 -m http.server 3055 --bind 127.0.0.1");
    await waitForOutput(page, "Serving HTTP");

    const portRow = page.getByRole("button", { name: /:3055/ });
    await expect(portRow).toBeVisible({ timeout: 30_000 });
    await portRow.click();

    const frame = page.locator("iframe.prev-frame");
    await expect(frame).toHaveAttribute("src", /\/preview\/3055\//);
    // Without a preview domain the path proxy is same-origin, so the frame
    // must be sandboxed without allow-same-origin.
    const sandbox = await frame.getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");

    // The proxy really serves the directory listing python is producing.
    const body = page.frameLocator("iframe.prev-frame").locator("body");
    await expect(body).toContainText("Directory listing", { timeout: 30_000 });
  });
});
