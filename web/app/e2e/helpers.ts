import { expect, type Page } from "@playwright/test";

declare global {
  interface Window {
    __workbench?: {
      termText(paneId: string): string | null;
      paneIds(): string[];
    };
  }
}

/** The pane ids the app currently has live terminals for. */
export function paneIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__workbench?.paneIds() ?? []);
}

/**
 * What a terminal is showing. xterm renders to a canvas, so there is no DOM
 * text to read; the app exposes its buffer instead (see terminal/registry.ts).
 */
export function termText(page: Page, paneId: string): Promise<string> {
  return page.evaluate((id) => window.__workbench?.termText(id) ?? "", paneId);
}

/** Wait until some terminal shows `needle`, and return its pane id. */
export async function waitForOutput(page: Page, needle: string): Promise<string> {
  let found = "";
  await expect
    .poll(
      async () => {
        for (const id of await paneIds(page)) {
          if ((await termText(page, id)).includes(needle)) {
            found = id;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000, message: `no terminal ever showed ${needle}` },
    )
    .toBe(true);
  return found;
}

/** Type a command into the focused terminal and run it. */
export async function runCommand(page: Page, command: string): Promise<void> {
  await page.locator(".term-host").first().click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

/** Open the command palette and run the entry whose label matches. */
export async function runFromPalette(page: Page, label: string): Promise<void> {
  // The chord: Ctrl+K is left to a terminal being typed into.
  await page.keyboard.press("Control+Alt+k");
  const input = page.getByLabel("Command palette query");
  await expect(input).toBeFocused();
  await input.fill(label);
  await page.getByRole("option", { name: label }).first().click();
}
