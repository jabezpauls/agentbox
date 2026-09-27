import { expect, test, type Page } from "@playwright/test";
import { GATE, PASSWORD, USER, gateApi, signIn, totp } from "./gate.ts";

// The gate trusts the loopback address as its proxy in this harness, so a test
// can be its own client by sending the header the proxy would set — which keeps
// one test's failed attempts from rate-limiting the next.
async function asClient(page: Page, ip: string): Promise<void> {
  await page.context().setExtraHTTPHeaders({ "x-agentbox-client-ip": ip });
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
  await page.goto("/workbench");
  await expect(page).toHaveURL(`${GATE}/login?next=${encodeURIComponent("/workbench")}`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Remember this device for 30 days")).toBeVisible();
});

test("a wrong password is refused calmly, without saying which half was wrong", async ({ page }) => {
  await asClient(page, "203.0.113.11");
  await page.goto("/workbench");
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
  // Enrolling is a sensitive change: it takes the password again, in the request.
  const setup = await gateApi(page, "POST", "/_gate/totp/setup", { password: PASSWORD });
  expect(setup.status).toBe(200);
  const secret = setup.body.secret as string;
  const confirm = await gateApi(page, "POST", "/_gate/totp/confirm", { code: totp(secret), password: PASSWORD });
  expect(confirm.status).toBe(200);
  const recoveryCodes = confirm.body.recoveryCodes as string[];

  try {
    expect((await gateApi(page, "POST", "/_gate/logout")).status).toBe(204);
    // Signing in and enrolling spent three of this address's five password
    // checks a minute (setup and confirm each take the password); the sign-in
    // below takes three more, so it comes from an address of its own.
    await asClient(page, "203.0.113.15");
    await page.goto("/workbench");
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
    await expect(page).toHaveURL(`${GATE}/workbench`);
    await expect(page.locator(".conn-pill.is-open")).toBeVisible();
  } finally {
    // Leave the box as the other tests expect it: two-factor off, which takes
    // the password and a second factor — a recovery code, since the next
    // authenticator code is already spent. If the test failed signed out,
    // another recovery code gets back in first. Run from /login, which the
    // app's session guard does not watch, as a client of its own: the password
    // checks above have spent this test's budget of five a minute.
    await asClient(page, "203.0.113.22");
    await page.goto(`${GATE}/login`);
    let off = await gateApi(page, "DELETE", "/_gate/totp", { password: PASSWORD, code: recoveryCodes[1] });
    if (off.status !== 204) {
      await gateApi(page, "POST", "/_gate/login", { username: USER, password: PASSWORD, code: recoveryCodes[0] });
      off = await gateApi(page, "DELETE", "/_gate/totp", { password: PASSWORD, code: recoveryCodes[2] });
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
  await expect(page).toHaveURL(`${GATE}/login?next=${encodeURIComponent("/")}`);

  // Coming back needs the password again.
  await page.goto("/workbench");
  await expect(page).toHaveURL(/\/login\?next=/);
});

test("with JavaScript off, signing in is a plain form post that lands where it was going", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: { "x-agentbox-client-ip": "203.0.113.13" } });
  const page = await context.newPage();
  try {
    await page.goto("/workbench");
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByLabel("Username").fill(USER);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    // The server renders the answer: no script needed.
    await expect(page.locator("#login-message")).toHaveText("That username and password don’t match. Check both and try again.");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${GATE}/workbench`);
    const cookies = await context.cookies();
    expect(cookies.some((c) => c.name === "__Host-agentbox" && c.httpOnly && c.secure)).toBe(true);
  } finally {
    await context.close();
  }
});

test("approving a CLI login on /settings/devices asks for the password, then hands the CLI its token", async ({ page, request }) => {
  await asClient(page, "203.0.113.14");
  // The CLI's side: start a login (no session, no Origin — as the CLI sends it).
  const started = await request.post(`${GATE}/_gate/device/start`, { data: { name: "e2e laptop" } });
  expect(started.status()).toBe(200);
  const { deviceCode, userCode, verifyUrl } = (await started.json()) as { deviceCode: string; userCode: string; verifyUrl: string };

  // The owner opens the link the CLI printed: sign in first, then back here.
  await page.goto(verifyUrl);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel("Username").fill(USER);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/settings/devices\\?code=${userCode}$`));
  await expect(page.getByRole("heading", { name: "Allow “e2e laptop” full access?" })).toBeVisible();
  await expect(page.getByText(userCode)).toBeVisible();

  // Approving hands out full access: the page asks for the password again.
  await page.getByLabel("Your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("heading", { name: "Device approved" })).toBeVisible();

  const polled = await request.post(`${GATE}/_gate/device/poll`, { data: { deviceCode } });
  expect(polled.status()).toBe(200);
  const { token } = (await polled.json()) as { token: string };
  expect(token).toMatch(/^abx_/);
  const whoami = await request.get(`${GATE}/_gate/session`, { headers: { authorization: `Bearer ${token}` } });
  expect(await whoami.json()).toMatchObject({ kind: "token", name: "e2e laptop" });
  // The CLI's logout.
  expect((await request.delete(`${GATE}/_gate/tokens/self`, { headers: { authorization: `Bearer ${token}` } })).status()).toBe(204);
});
