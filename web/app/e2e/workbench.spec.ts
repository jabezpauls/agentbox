import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { paneIds, runCommand, runFromPalette, termText, waitForOutput } from "./helpers.ts";

const PORT = Number(process.env.WORKBENCH_PORT ?? 7800);
const REVIEW_URL = `http://127.0.0.1:${PORT}/workbench`;
// The CLI the image installs, run exactly as an agent in the sandbox runs it.
const REVIEW_CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../images/workspace/agentbox-review",
);

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
    expect(link).toContain("?review=");
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
