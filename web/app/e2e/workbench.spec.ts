import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { signIn } from "./gate.ts";
import { paneIds, runCommand, runFromPalette, termText, waitForOutput } from "./helpers.ts";

// The bridge's own port: the in-sandbox CLI calls it directly, never through
// the gate. The browser only ever sees the gate.
const PORT = Number(process.env.WORKBENCH_PORT ?? 7800);
const REVIEW_URL = `http://127.0.0.1:${PORT}`;
// The CLI the image installs, run exactly as an agent in the sandbox runs it.
const REVIEW_CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../images/workspace/agentbox-review",
);

/**
 * A currently-free TCP port on loopback. Binding :0 lets the kernel pick one
 * that is actually available, so the preview step never fails misleadingly just
 * because a fixed port was already taken on the box the suite runs on.
 */
function freePort(): Promise<number> {
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

function review(...args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [REVIEW_CLI, ...args],
      { env: { ...process.env, AGENTBOX_REVIEW_URL: REVIEW_URL } },
      (err, stdout) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
        resolve({ code, stdout });
      },
    );
  });
}

// One session, run in order: each step builds on the workspace the previous
// one created, the way a person uses the app. Splitting these into independent
// tests would mean creating a workspace four times for no extra coverage.
test.describe.configure({ mode: "serial" });

// Everything is behind the gate: sign in through the real page first. Each
// test signs in as a client of its own (the harness trusts loopback as the
// proxy, see e2e/gate.ts): the gate allows five password checks a minute per
// address, and the whole suite signs in more often than that.
let client = 0;
test.beforeEach(async ({ page }) => {
  client += 1;
  await page.context().setExtraHTTPHeaders({ "x-agentbox-client-ip": `203.0.113.${100 + client}` });
  await signIn(page);
});

test("the Workbench drives herdr end to end", async ({ page }) => {
  await page.goto("/workbench");

  await test.step("it starts empty and connected", async () => {
    await expect(page.getByText("Nothing open.")).toBeVisible();
    await expect(page.getByText(/No workspaces yet\./)).toBeVisible();
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
    // The theme is chosen in the palette (or Settings → Appearance).
    await runFromPalette(page, "Theme: dark");
    await expect(html).toHaveAttribute("data-theme", "dark");
    expect(before).not.toBe("dark");
  });

  await test.step("a server started in a pane can be previewed as an app", async () => {
    const devPort = await freePort();
    await runCommand(page, `python3 -m http.server ${devPort} --bind 127.0.0.1`);
    await waitForOutput(page, "Serving HTTP");

    // Not an app yet: it is listed apart, and choosing it makes it one.
    const portRow = page.getByRole("list", { name: "Also listening" }).getByRole("button", { name: new RegExp(`:${devPort}\\b`) });
    await expect(portRow).toBeVisible({ timeout: 30_000 });
    await portRow.click();

    const frame = page.locator("iframe.prev-frame");
    await expect(frame).toHaveAttribute("src", /^\/a\/[a-z2-7]{26}\/$/);
    await expect(page.getByRole("list", { name: "Apps" })).toContainText(`:${devPort}`);
    // Every app runs with an opaque origin: never allow-same-origin.
    const sandbox = await frame.getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");

    // The proxy really serves the directory listing python is producing.
    const body = page.frameLocator("iframe.prev-frame").locator("body");
    await expect(body).toContainText("Directory listing", { timeout: 30_000 });
  });
});

test("an agent's artifact comes back with the human's comments on it", async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-artifact-"));
  const file = path.join(dir, "plan.html");
  fs.writeFileSync(
    file,
    `<!doctype html><html><body style="font:16px system-ui;padding:24px">
       <h1>Rollout plan</h1>
       <h2 id="phases">Phases</h2>
       <p>Everything at once, on Friday.</p>
     </body></html>`,
  );

  let link = "";
  await test.step("the agent publishes it with one command", async () => {
    const opened = await review("open", file, "--label", "Rollout plan");
    expect(opened.code).toBe(0);
    expect(opened.stdout).toMatch(/key: [0-9a-f]{8}/);
    link = opened.stdout.split("\n")[0] as string;
    expect(link).toContain("/workbench?review=");
  });

  await test.step("the link it printed opens the drawer on that session", async () => {
    // Exactly what a person does with the URL the agent hands them.
    await page.goto(link);
    await expect(page.locator(".inspector")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true");

    const body = page.frameLocator("iframe.review-frame").locator("body");
    await expect(body).toContainText("Everything at once");
  });

  await test.step("clicking an element in it anchors a comment", async () => {
    await page.getByRole("button", { name: /Annotate/ }).click();
    await page.frameLocator("iframe.review-frame").locator("#phases").click();

    const note = page.getByLabel(/^Comment on/);
    await expect(note).toBeVisible();
    await note.fill("split this into two phases");
    await page.getByRole("button", { name: "Send", exact: true }).click();
  });

  await test.step("the agent's poll prints it", async () => {
    const polled = await review("poll", file, "--timeout", "20");
    expect(polled.code).toBe(0);
    const json = JSON.parse(polled.stdout) as {
      comments: { kind: string; anchor?: string; quote?: string; note: string }[];
    };
    expect(json.comments).toHaveLength(1);
    expect(json.comments[0]).toMatchObject({ kind: "element", note: "split this into two phases" });
    expect(json.comments[0]?.anchor).toContain("phases");
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

test("the app answers at the root, on its own routes and at the old prefix", async ({ page }) => {
  await test.step("a deep link loads the app, not a 404", async () => {
    await page.goto("/files/demo/some/deep/path");
    await expect(page.locator(".conn-pill.is-open")).toBeVisible();
  });

  await test.step("an old /workbench/ bookmark lands on the Workbench route", async () => {
    await page.goto("/workbench/");
    await expect(page).toHaveURL(/\/workbench$/);
    await expect(page.locator(".conn-pill.is-open")).toBeVisible();
  });
});
