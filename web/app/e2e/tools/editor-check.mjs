#!/usr/bin/env node
// Check the kept-alive editor against a real code-server with the
// agentbox-connect extension, which the e2e harness does not have:
//
//   node e2e/tools/editor-check.mjs <gate url> <file> <another file> [shots dir]
//
// Run the stack (e2e/start-stack.mjs) with E2E_CODE_PORT pointing at a
// code-server from the workspace image, sharing the host's loopback so its
// extension reaches the bridge — docs/workbench.md has the command. The
// script opens the file from Files with "Open in editor", types into it,
// tours the other surfaces, and checks the editor kept its frame and the
// unsaved text, and that ⌃⌥ chords work from inside VS Code. Then that VS
// Code's theme follows the app's light and dark, and that once a tab with
// the editor is closed — code-server keeps its window alive for hours — the
// next "Open in editor" still lands in the tab you are using.
import { chromium } from "@playwright/test";

const [base, file, other, shots] = process.argv.slice(2);
if (!base || !file || !other) {
  console.error("usage: editor-check.mjs <gate url> <file> <another file> [shots dir]");
  process.exit(2);
}
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  extraHTTPHeaders: { "x-agentbox-client-ip": `198.51.100.${Math.floor(Math.random() * 250) + 1}` },
});
const page = await context.newPage();
const step = (s) => console.log(`- ${s}`);
const fail = async (why) => {
  console.error(`FAILED: ${why}`);
  if (shots) await page.screenshot({ path: `${shots}/editor-check-failure.png` });
  await browser.close();
  process.exit(1);
};

await page.goto(`${base}/login?next=${encodeURIComponent(`/files${file}`)}`);
await page.getByLabel("Username").fill(process.env.E2E_USER ?? "e2e");
await page.getByLabel("Password").fill(process.env.E2E_PASSWORD ?? "e2e-password-1");
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/login"));

const look = page.getByRole("dialog", { name: /Quick look/ });
await look.waitFor({ timeout: 15_000 }).catch(() => fail("quick look did not open"));
step("quick look opened the file");
await look.getByRole("button", { name: "Open in editor" }).click();
await page.waitForURL(/\/editor$/);
step("switched to the editor");

const vscode = page.frameLocator("iframe.editor-frame");
const name = file.split("/").pop();
await vscode.locator(`.tab[aria-label^="${name}"], .tab:has-text("${name}")`).first().waitFor({ timeout: 90_000 }).catch(() => fail(`${name} never opened as a tab in VS Code`));
step(`VS Code opened ${name} (via agentbox-connect)`);

await vscode.locator(".monaco-editor .view-lines").first().click();
await page.keyboard.press("Control+End");
await page.keyboard.type("\nkept alive by the shell");
await vscode.locator(".view-lines", { hasText: "kept alive by the shell" }).first().waitFor({ timeout: 10_000 });
step("typed into the editor");
const frameHandle = await page.locator("iframe.editor-frame").elementHandle();
await page.evaluate((el) => (el.dataset.checkMark = "same-frame"), frameHandle);

// ⌃⌥ + a key from inside VS Code goes to another surface.
await page.keyboard.press("Control+Alt+4");
await page.waitForURL(/\/files/);
step("⌃⌥4 from inside VS Code went to Files");
await page.keyboard.press("Control+Alt+1");
await page.waitForURL((u) => u.pathname === "/");
await page.keyboard.press("Control+Alt+6");
await page.waitForURL(/\/system/);
step("toured Home and System");
await page.keyboard.press("Control+Alt+3");
await page.waitForURL(/\/editor$/);
const mark = await page.locator("iframe.editor-frame").getAttribute("data-check-mark");
if (mark !== "same-frame") await fail("the editor's frame was recreated");
await vscode.locator(".view-lines", { hasText: "kept alive by the shell" }).first().waitFor({ timeout: 5000 }).catch(() => fail("the unsaved text was lost"));
step("back in the editor: same frame, unsaved text still there");
if (shots) await page.screenshot({ path: `${shots}/editor-check.png` });
// Leave the file as it was: undo the typing without saving.
await page.keyboard.press("Control+z");

// VS Code's theme follows the app's: the workbench is `vs` in light and
// `vs-dark` in dark.
const workbench = vscode.locator(".monaco-workbench").first();
async function appTheme(kind) {
  // In-app, as a link would: a full load would rebuild the editor's frame.
  await page.evaluate(() => {
    history.pushState(null, "", "/settings/appearance");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.getByRole("radio", { name: new RegExp(`^${kind}`, "i") }).click();
  await page.keyboard.press("Control+Alt+3");
  await page.waitForURL(/\/editor$/);
  const want = kind === "dark" ? /\bvs-dark\b/ : /\bvs\b(?!-)/;
  for (let i = 0; i < 100; i++) {
    const cls = (await workbench.getAttribute("class").catch(() => "")) ?? "";
    if (want.test(cls)) return;
    await page.waitForTimeout(100);
  }
  await fail(`VS Code did not turn ${kind} with the app`);
}
await appTheme("dark");
step("the app turned dark, and VS Code with it");
if (shots) await page.screenshot({ path: `${shots}/editor-check-dark.png` });
await appTheme("light");
step("the app turned light, and VS Code with it");

// A second tab with the editor, then the first closed: its window lingers
// in code-server, and was the last one focused.
const second = await context.newPage();
await second.goto(`${base}/editor`);
const secondCode = second.frameLocator("iframe.editor-frame");
await secondCode.locator(".monaco-workbench").first().waitFor({ timeout: 90_000 }).catch(() => fail("the second tab's editor never loaded"));
await vscode.locator(".monaco-editor .view-lines").first().click();
await page.close();
step("closed the first tab after focusing its editor last");
const otherName = other.split("/").pop();
await second.goto(`${base}/files${other}`);
const look2 = second.getByRole("dialog", { name: /Quick look/ });
await look2.waitFor({ timeout: 15_000 }).catch(() => fail("quick look did not open in the second tab"));
await look2.getByRole("button", { name: "Open in editor" }).click();
await secondCode
  .locator(`.tab[aria-label^="${otherName}"], .tab:has-text("${otherName}")`)
  .first()
  .waitFor({ timeout: 30_000 })
  .catch(() => fail(`${otherName} went to the closed tab's lingering window, not this one`));
step(`"Open in editor" landed in the tab in use, not the closed one's window`);
await browser.close();
console.log("OK");
