import { expect, test, type Page } from "@playwright/test";
import { clientIp, signIn } from "./gate.ts";
import { closeAllWorkspaces, paneIds, runFromPalette, termText, waitForOutput } from "./helpers.ts";

/**
 * The terminal's typing modes, end to end through the real bridge and herdr:
 * predictive echo (with the terminal socket slowed to a proxy's round trip),
 * the compose bar, and dictation with a stand-in for the browser's speech API.
 */

/** What the far side of the public proxy feels like: each way, this long. */
const ONE_WAY_MS = 120;

/** Hold every terminal frame for ONE_WAY_MS in each direction, in order. */
async function slowTerminalSocket(page: Page): Promise<void> {
  await page.routeWebSocket(/\/ws\/terminal/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => setTimeout(() => server.send(m), ONE_WAY_MS));
    server.onMessage((m) => setTimeout(() => ws.send(m), ONE_WAY_MS));
  });
}

async function freshPane(page: Page): Promise<string> {
  await page.goto("/workbench");
  await closeAllWorkspaces(page);
  await runFromPalette(page, "New workspace");
  await page.getByRole("button", { name: /use this folder/i }).click();
  await expect.poll(async () => (await paneIds(page)).length).toBe(1);
  const [pane] = await paneIds(page);
  // A prompt, so typing lands on a shell that echoes.
  await expect.poll(async () => /\$\s*$/m.test(await termText(page, pane!)), { timeout: 30_000 }).toBe(true);
  return pane!;
}

/** The predicted characters painted right now, left to right. */
function predicted(page: Page): Promise<string> {
  return page.evaluate(() => [...document.querySelectorAll(".term-predict-cell")].map((c) => c.textContent).join(""));
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ "x-agentbox-client-ip": clientIp() });
  await signIn(page);
});

test("predictive echo paints keys before their echo, and lets the echo replace them", async ({ page }) => {
  await slowTerminalSocket(page);
  const pane = await freshPane(page);
  await page.locator(".term-host").first().click();
  // Wait out a ping, so the socket knows its round trip is slow.
  await page.waitForTimeout(800);

  await test.step("a new line's first key waits for its echo, then the rest show at once", async () => {
    await page.keyboard.type("e");
    expect(await predicted(page)).toBe("");
    // Its echo, a round trip later, confirms the line echoes.
    await page.waitForTimeout(4 * ONE_WAY_MS);
    await page.keyboard.type("cho");
    // Painted locally, well before the round trip could bring the echo back.
    await expect.poll(() => predicted(page), { timeout: 2 * ONE_WAY_MS - 20 }).toBe("cho");
    expect(await termText(page, pane)).not.toContain("echo");
    // Then the echo lands, and the guesses give way to it.
    await expect.poll(async () => (await termText(page, pane)).includes("echo")).toBe(true);
    await expect.poll(() => predicted(page)).toBe("");
  });

  await test.step("a backspace is predicted too, and the line still runs as typed", async () => {
    await page.keyboard.type(" PREDICTX");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("_OK");
    await expect.poll(() => predicted(page)).toBe("");
    await page.keyboard.press("Enter");
    await waitForOutput(page, "\nPREDICT_OK");
  });

  await test.step("nothing is painted at a prompt that does not echo", async () => {
    await page.keyboard.type("read -s -p 'secret: ' S; echo GOT_${#S}");
    await expect.poll(() => predicted(page)).toBe("");
    await page.keyboard.press("Enter");
    await waitForOutput(page, "secret:");
    const seen = new Set<string>();
    for (const ch of "hunter2") {
      await page.keyboard.type(ch);
      seen.add(await predicted(page));
      await page.waitForTimeout(40);
    }
    for (let i = 0; i < 10; i++) {
      seen.add(await predicted(page));
      await page.waitForTimeout(50);
    }
    expect([...seen]).toEqual([""]);
    await page.keyboard.press("Enter");
    await waitForOutput(page, "GOT_7");
  });
});

test("the compose bar sends whole lines, remembers them, and steps aside for full-screen programs", async ({ page }) => {
  const pane = await freshPane(page);
  await page.getByRole("button", { name: /^Pane actions for/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "Compose bar" }).click();
  const bar = page.getByLabel("Compose a line for the terminal");
  await expect(bar).toBeVisible();

  await test.step("Enter sends the line", async () => {
    await bar.click();
    await bar.fill("echo COMPOSED_$((6*7))");
    await bar.press("Enter");
    await waitForOutput(page, "COMPOSED_42");
    await expect(bar).toHaveValue("");
  });

  await test.step("↑ brings it back", async () => {
    await bar.press("ArrowUp");
    await expect(bar).toHaveValue("echo COMPOSED_$((6*7))");
    await bar.fill("");
  });

  await test.step("a full-screen program takes the keys, and the bar returns after it", async () => {
    await bar.fill("less /etc/passwd");
    await bar.press("Enter");
    await expect(bar).toBeHidden();
    await page.keyboard.press("q");
    await expect(bar).toBeVisible();
    await expect(bar).toBeFocused();
    await bar.fill("echo BACK_$((2*3))");
    await bar.press("Enter");
    await expect.poll(async () => (await termText(page, pane)).includes("BACK_6")).toBe(true);
  });

  await test.step("the quick keys go straight through", async () => {
    await bar.fill("sleep 30");
    await bar.press("Enter");
    await page.waitForTimeout(300);
    await page.getByTitle("Ctrl+C — interrupt").click();
    await bar.fill("echo AFTER_$((3*3))");
    await bar.press("Enter");
    await waitForOutput(page, "AFTER_9");
  });

  await test.step("dictation inserts the words heard into the bar, unsent", async () => {
    await page.evaluate(() => {
      class FakeRecognition {
        static last: FakeRecognition | null = null;
        continuous = false;
        interimResults = false;
        lang = "";
        onresult: ((e: unknown) => void) | null = null;
        onerror: ((e: unknown) => void) | null = null;
        onend: (() => void) | null = null;
        constructor() {
          FakeRecognition.last = this;
          (window as unknown as { __rec: FakeRecognition }).__rec = this;
        }
        start() {}
        stop() {
          this.onend?.();
        }
        abort() {}
      }
      // Chromium has the API (unprefixed, lately): stand in for both names.
      Object.assign(window, { SpeechRecognition: FakeRecognition, webkitSpeechRecognition: FakeRecognition });
    });
    // (The bar looks for the speech API as it renders; filling it re-renders.)
    await bar.fill("echo ");
    await page.getByRole("button", { name: "Dictate" }).click();
    await expect(page.getByRole("button", { name: "Stop dictation" })).toBeVisible();
    const say = (text: string, isFinal: boolean) =>
      page.evaluate(
        ([text, isFinal]) =>
          (window as unknown as { __rec: { onresult(e: unknown): void } }).__rec.onresult({
            resultIndex: 0,
            results: [{ isFinal, 0: { transcript: text } }],
          }),
        [text, isFinal] as const,
      );
    await say("hello wor", false);
    await expect(page.locator(".composer-interim")).toHaveText("hello wor");
    await say("hello world", true);
    await expect(bar).toHaveValue("echo hello world");
    await page.getByRole("button", { name: "Stop dictation" }).click();
    expect(await termText(page, pane)).not.toContain("hello world");
  });
});
