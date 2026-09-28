import { expect, test, type Cookie, type Page, type Route } from "@playwright/test";
import { resume, sharedSession } from "./session.ts";

/**
 * The bridge down behind a gate that is up — a restart, a crash — as the
 * browser sees it: every /api/ request a 502 and the events socket closing
 * as soon as it opens. Each surface must say it cannot reach the box, with a
 * way to try again, instead of a skeleton for ever or a guess dressed as
 * fact ("Nothing is listening", "No agents working").
 */

let cookies: Cookie[] = [];
test.beforeAll(async ({ browser }) => {
  cookies = await sharedSession(browser, "203.0.113.150");
});

const badGateway = (route: Route) => route.fulfill({ status: 502, contentType: "text/plain", body: "Bad Gateway" });

async function bridgeDown(page: Page): Promise<void> {
  await page.route(/\/api\//, badGateway);
  await page.route(/\/_gate\/sessions/, badGateway);
  await page.routeWebSocket(/\/ws\//, (ws) => ws.close());
}

const surface = (page: Page, id: string) => page.locator(`section.surface[data-surface="${id}"][data-active]`);

test("with the bridge down, each surface says it cannot reach the box", async ({ page }) => {
  await page.context().addCookies(cookies);
  await bridgeDown(page);
  await resume(page, cookies, "/");

  const home = surface(page, "home");
  await expect(home.getByRole("heading", { name: "Out of reach" })).toBeVisible();
  await expect(home.getByText("The box is not answering. Reconnecting…")).toBeVisible();
  await expect(home.getByText("No agents working")).toHaveCount(0);
  await expect(home.getByText("Couldn't read the workspace.")).toBeVisible();
  await expect(home.getByText("Couldn't read the apps.")).toBeVisible();
  await expect(home.getByText(/Couldn't read the system\./)).toBeVisible();
  await expect(home.locator(".skeleton")).toHaveCount(0);

  await page.goto("/apps");
  const apps = surface(page, "apps");
  await expect(apps.getByText("Couldn't read the apps.")).toBeVisible();
  await expect(apps.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(apps.getByText(/what is listening is not known/)).toBeVisible();
  await expect(apps.getByText("Nothing else is listening.", { exact: false })).toHaveCount(0);
  await expect(apps.locator(".skeleton")).toHaveCount(0);

  await page.goto("/system");
  const system = surface(page, "system");
  await expect(system.getByText("Couldn't read the system.")).toBeVisible();
  await expect(system.getByText("The box is not answering.")).toBeVisible();
  await expect(system.getByText("Reading the box…")).toHaveCount(0);

  await page.goto("/settings/account");
  const settings = surface(page, "settings");
  await expect(settings.getByText("Couldn't read the sessions.")).toBeVisible();

  await page.goto("/files");
  const files = surface(page, "files");
  await expect(files.getByText("Couldn't reach the box.")).toBeVisible();
  await expect(files.getByRole("button", { name: "Retry" })).toBeVisible();
});
