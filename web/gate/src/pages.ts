/**
 * The gate's own pages: sign-in, and the device-approval page the CLI's login
 * opens. Rendered on the server, so each works as a plain form post with
 * JavaScript off; `login.js` only makes the two-step sign-in smoother.
 *
 * Styled with the app's own tokens (`tokens.css`, copied in at build time), and
 * served under a policy that allows nothing but this origin's own files.
 */

export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
].join("; ");

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** "12 seconds", "3 minutes": how long to wait, rounded up, never "0". */
export function waitPhrase(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 90) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.ceil(s / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

export type LoginError =
  | "invalid"
  | "code_required"
  | "invalid_code"
  | "rate"
  | "locked"
  | "busy"
  | "not_set_up"
  | "bad_request"
  | "cross_site";

/**
 * What the sign-in page says for each outcome. Calm and specific, and never
 * which of the username or the password was wrong.
 */
export function loginMessage(error: LoginError, retryAfterMs = 0): string {
  switch (error) {
    case "invalid":
      return "That username and password don’t match. Check both and try again.";
    case "code_required":
      return "Enter the 6-digit code from your authenticator app.";
    case "invalid_code":
      return "That code didn’t work. Codes change every 30 seconds — use the current one, or a recovery code.";
    case "rate":
      return `Too many attempts. Try again in ${waitPhrase(retryAfterMs)}.`;
    case "locked":
      return `Too many failed attempts. Sign-in from your network is paused for ${waitPhrase(retryAfterMs)}.`;
    case "busy":
      return `Sign-in is refusing attempts for a moment. Try again in ${waitPhrase(retryAfterMs)}.`;
    case "not_set_up":
      return "No password is set on this box yet. On the server, run ./scripts/agentbox passwd.";
    case "bad_request":
      return "Enter your username and password.";
    case "cross_site":
      return "That sign-in did not come from this page, so it was refused. Reload and try again.";
  }
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/login/assets/tokens.css">
<link rel="stylesheet" href="/login/assets/login.css">
<script src="/login/assets/login.js"></script>
</head>
<body>
<main class="gate">
<div class="gate-brand" aria-hidden="true"><span class="gate-mark"></span>agentbox</div>
${body}
</main>
</body>
</html>
`;
}

export interface LoginView {
  next: string;
  username: string;
  host: string;
  needCode: boolean;
  error: LoginError | null;
  retryAfterMs: number;
}

export function renderLogin(v: LoginView): string {
  const message = v.error ? loginMessage(v.error, v.retryAfterMs) : "";
  // code_required is a step, not a failure: it reads as guidance.
  const tone = v.error === "code_required" ? "info" : "error";
  return shell(
    "Sign in · agentbox",
    `<section class="gate-card" aria-labelledby="gate-title">
<h1 id="gate-title" class="gate-title">Sign in</h1>
<p class="gate-sub">to ${escapeHtml(v.host)}</p>
<form class="gate-form" id="login-form" method="post" action="/_gate/login" data-need-code="${v.needCode ? "1" : "0"}">
<input type="hidden" name="next" value="${escapeHtml(v.next)}">
<div class="field">
<label class="field-label" for="username">Username</label>
<input class="input" id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${escapeHtml(v.username)}"${v.username ? "" : " autofocus"}>
</div>
<div class="field">
<label class="field-label" for="password">Password</label>
<input class="input" id="password" name="password" type="password" autocomplete="current-password" required${v.username && !v.needCode ? " autofocus" : ""}>
</div>
<div class="field" id="code-field"${v.needCode ? "" : " hidden"}>
<label class="field-label" for="code">Two-factor code</label>
<input class="input" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" spellcheck="false" placeholder="123456"${v.needCode ? " autofocus" : ""}>
<p class="gate-hint">The 6-digit code from your authenticator app, or one of your recovery codes.</p>
</div>
<label class="check"><input type="checkbox" name="remember" value="1"> Remember this device for 30 days</label>
<p class="gate-msg is-${tone}" id="login-message" role="alert"${message ? "" : " hidden"}>${escapeHtml(message)}</p>
<button class="btn btn-primary gate-submit" type="submit">Sign in</button>
</form>
</section>`,
  );
}

export interface DeviceView {
  /** The login waiting for a decision, when the code matched one. */
  pending: { userCode: string; name: string; ip: string; createdAt: number } | null;
  /** The code the page was opened with, when it matched nothing live. */
  unknownCode: string | null;
  /** The outcome of a decision just made. */
  result: "approved" | "denied" | "gone" | null;
  /** Two-factor is on: approving asks for a code as well as the password. */
  twoFactor: boolean;
  /** Why the last attempt to approve was refused. */
  error: string | null;
}

/**
 * The passcode page is served under an app's path, and so under the app
 * policy's sandbox: an opaque origin, where the box's own files are
 * cross-origin. So it carries its styles inline (the same tokens and rules as
 * the sign-in page, without the web font) and runs no script at all.
 */
export const PASSCODE_CSP = ["default-src 'none'", "style-src 'unsafe-inline'", "img-src data:", "base-uri 'none'", "frame-ancestors 'self'"].join("; ");

export interface PasscodeView {
  name: string;
  /** Where the form posts: the app's own unlock path. */
  action: string;
  /** Where to go once unlocked. */
  next: string;
  error: "invalid" | "rate" | "locked" | "busy" | null;
  retryAfterMs: number;
  /** The tokens and the sign-in stylesheet, to inline. */
  styles: string;
}

export function renderPasscode(v: PasscodeView): string {
  const message =
    v.error === "invalid"
      ? "That passcode isn’t right. Check it with whoever shared this link."
      : v.error
        ? loginMessage(v.error, v.retryAfterMs)
        : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(v.name)} · passcode</title>
<style>${v.styles}</style>
</head>
<body>
<main class="gate">
<div class="gate-brand" aria-hidden="true"><span class="gate-mark"></span>agentbox</div>
<section class="gate-card" aria-labelledby="gate-title">
<h1 id="gate-title" class="gate-title">${escapeHtml(v.name)}</h1>
<p class="gate-sub">This app is shared with a passcode.</p>
<form class="gate-form" method="post" action="${escapeHtml(v.action)}">
<input type="hidden" name="next" value="${escapeHtml(v.next)}">
<div class="field">
<label class="field-label" for="passcode">Passcode</label>
<input class="input" id="passcode" name="passcode" type="password" autocomplete="off" required autofocus>
</div>
<p class="gate-msg is-error" role="alert"${message ? "" : " hidden"}>${escapeHtml(message)}</p>
<button class="btn btn-primary gate-submit" type="submit">Open</button>
</form>
</section>
</main>
</body>
</html>
`;
}

export function renderDevices(v: DeviceView): string {
  if (v.result) {
    const [title, text] =
      v.result === "approved"
        ? ["Device approved", "The CLI is signed in. You can close this tab and return to your terminal."]
        : v.result === "denied"
          ? ["Request denied", "The CLI was refused and holds no access. You can close this tab."]
          : ["Nothing to approve", "That request has expired or was already answered. Start the login again from your terminal."];
    return shell(
      `${title} · agentbox`,
      `<section class="gate-card"><h1 class="gate-title">${title}</h1><p class="gate-sub">${text}</p></section>`,
    );
  }
  if (v.pending) {
    const p = v.pending;
    const when = new Date(p.createdAt).toISOString().replace("T", " ").slice(0, 16);
    // Approving hands out full access, so it asks for the password (and a
    // code), every time.
    const confirm = `<div class="field">
<label class="field-label" for="password">Your password</label>
<input class="input" id="password" name="password" type="password" autocomplete="current-password" required autofocus>
</div>${
      v.twoFactor
        ? `
<div class="field">
<label class="field-label" for="code">Two-factor code</label>
<input class="input" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" spellcheck="false" required>
</div>`
        : ""
    }`;
    const error = v.error ? `<p class="gate-msg is-error" role="alert">${escapeHtml(v.error)}</p>` : "";
    return shell(
      "Approve a device · agentbox",
      `<section class="gate-card" aria-labelledby="gate-title">
<h1 id="gate-title" class="gate-title">Allow “${escapeHtml(p.name)}” full access?</h1>
<p class="gate-sub">A command-line login is asking for a token that can do anything you can in this box. Approve it only if you just started it and the code below matches your terminal.</p>
<dl class="gate-facts">
<dt>Code</dt><dd class="gate-code">${escapeHtml(p.userCode)}</dd>
<dt>Requested from</dt><dd>${escapeHtml(p.ip)}</dd>
<dt>At</dt><dd>${escapeHtml(when)} UTC</dd>
</dl>
<form class="gate-form" id="approve-form" method="post" action="/_gate/device/approve">
<input type="hidden" name="userCode" value="${escapeHtml(p.userCode)}">
${confirm}
${error}
<button class="btn btn-primary gate-submit" type="submit">Approve</button>
</form>
<form class="gate-actions" method="post" action="/_gate/device/deny"><input type="hidden" name="userCode" value="${escapeHtml(p.userCode)}"><button class="btn" type="submit">Deny</button></form>
</section>`,
    );
  }
  const note = v.unknownCode
    ? `<p class="gate-msg is-error" role="alert">No login is waiting for ${escapeHtml(v.unknownCode)}. It may have expired; start again from your terminal.</p>`
    : "";
  return shell(
    "Approve a device · agentbox",
    `<section class="gate-card" aria-labelledby="gate-title">
<h1 id="gate-title" class="gate-title">Approve a device</h1>
<p class="gate-sub">Enter the code your terminal shows.</p>
<form class="gate-form" method="get" action="/settings/devices">
<div class="field">
<label class="field-label" for="code">Code</label>
<input class="input gate-code" id="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" required autofocus>
</div>
${note}
<button class="btn btn-primary gate-submit" type="submit">Continue</button>
</form>
</section>`,
  );
}
