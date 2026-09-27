import { expect, test, type Page } from "@playwright/test";
import { GATE, PASSWORD, USER, gateApi, signIn, totp } from "./gate.ts";

// The gate trusts the loopback address as its proxy in this harness, so a test
// can be its own client by sending X-Forwarded-For — which keeps one test's
// failed attempts from rate-limiting the next.
async function asClient(page: Page, ip: string): Promise<void> {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip });
}

async function submit(page: Page, password: string): Promise<void> {
  await page.getByLabel("Username").fill(USER);
  await page.getByLabel("Password").fill(password);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/_gate/login")),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
}

const message = (page: Page) => page.locator("#login-message");

test("a page load without a session lands on the sign-in page", async ({ page }) => {
  await page.goto("/workbench/");
  await expect(page).toHaveURL(`${GATE}/login?next=${encodeURIComponent("/workbench/")}`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Remember this device for 30 days")).toBeVisible();
});

test("a wrong password is refused calmly, without saying which half was wrong", async ({ page }) => {
  await asClient(page, "203.0.113.11");
  await page.goto("/workbench/");
  await submit(page, "not-the-password");
  await expect(message(page)).toHaveText("That username and password don’t match. Check both and try again.");
  await expect(page).toHaveURL(/\/login\?/);
  // The password field is cleared for another try; the username stays.
  await expect(page.getByLabel("Password")).toHaveValue("");
  await expect(page.getByLabel("Username")).toHaveValue(USER);
});

test("repeated failures pause sign-in, and say for how long — even for the right password", async ({ page }) => {
  await asClient(page, "203.0.113.10");
  await page.goto(`${GATE}/login`);
  for (let i = 0; i < 5; i++) {
    await submit(page, `wrong-${i}`);
    await expect(message(page)).toContainText("don’t match");
  }
  await submit(page, PASSWORD);
  await expect(message(page)).toHaveText(/^Too many attempts\. Try again in \d+ seconds?\.$/);
  await expect(page).toHaveURL(/\/login/);
});

test("with two-factor on, sign-in asks for the code and accepts it", async ({ page }) => {
  await asClient(page, "203.0.113.12");
  await signIn(page);
  const setup = await gateApi(page, "POST", "/_gate/totp/setup");
  expect(setup.status).toBe(200);
  const secret = setup.body.secret as string;
  const confirm = await gateApi(page, "POST", "/_gate/totp/confirm", { code: totp(secret) });
  expect(confirm.status).toBe(200);
  const recoveryCodes = confirm.body.recoveryCodes as string[];

  try {
    expect((await gateApi(page, "POST", "/_gate/logout")).status).toBe(204);
    await page.goto("/workbench/");
    await expect(page).toHaveURL(/\/login\?next=/);

    await submit(page, PASSWORD);
    await expect(page.getByLabel("Two-factor code")).toBeVisible();
    await expect(message(page)).toHaveText("Enter the 6-digit code from your authenticator app.");

    await page.getByLabel("Two-factor code").fill("000000");
    await Promise.all([page.waitForResponse((r) => r.url().endsWith("/_gate/login")), page.getByRole("button", { name: "Sign in" }).click()]);
    await expect(message(page)).toContainText("That code didn’t work");

    // The next period's code: the confirmation just used this one's.
    await page.getByLabel("Two-factor code").fill(totp(secret, 1));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${GATE}/workbench/`);
    await expect(page.locator(".conn-pill.is-open")).toBeVisible();
  } finally {
    // Leave the box as the other tests expect it: two-factor off. If the test
    // failed signed out, a recovery code gets back in to turn it off. Run from
    // /login, which the app's session guard does not watch.
    await page.goto(`${GATE}/login`);
    let off = await gateApi(page, "DELETE", "/_gate/totp", { password: PASSWORD });
    if (off.status !== 204) {
      await gateApi(page, "POST", "/_gate/login", { username: USER, password: PASSWORD, code: recoveryCodes[0] });
      off = await gateApi(page, "DELETE", "/_gate/totp", { password: PASSWORD });
    }
    expect(off.status).toBe(204);
  }
});

test("signing out ends the session, and the open app goes back to sign in", async ({ page }) => {
  await signIn(page);
  await expect(page.locator(".conn-pill.is-open")).toBeVisible();

  expect((await gateApi(page, "POST", "/_gate/logout")).status).toBe(204);

  // The app's next request is refused, and it sends the page to sign in,
  // remembering where it was.
  await page.evaluate(() => {
    void fetch("api/health");
  });
  await expect(page).toHaveURL(`${GATE}/login?next=${encodeURIComponent("/workbench/")}`);

  // Coming back needs the password again.
  await page.goto("/workbench/");
  await expect(page).toHaveURL(/\/login\?next=/);
});
