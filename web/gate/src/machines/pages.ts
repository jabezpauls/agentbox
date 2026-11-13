import { escapeHtml } from "../pages.js";

/**
 * The machines origin's own pages: the sign-in, and the shell the machines UI
 * mounts into. Served by the gate alone, never framed (not even by this
 * origin), under a policy that runs nothing but this origin's own files.
 *
 * The sign-in posts with script (machines.js), not as a plain form: every
 * response here says `Referrer-Policy: no-referrer`, under which a form post
 * carries `Origin: null`, and the machines origin takes no write without its
 * own origin in `Origin`.
 */

export const MACHINES_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

/** Where the machines pages' files are served (machines host only). */
export const MACHINES_ASSETS = "/_gate/machines/assets";

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/svg+xml" href="${MACHINES_ASSETS}/favicon.svg">
<link rel="stylesheet" href="${MACHINES_ASSETS}/tokens.css">
<link rel="stylesheet" href="${MACHINES_ASSETS}/login.css">
<script src="${MACHINES_ASSETS}/machines.js"></script>
</head>
<body>
<main class="gate">
<div class="gate-brand" aria-hidden="true"><span class="gate-mark"></span>agentbox machines</div>
${body}
</main>
</body>
</html>
`;
}

export interface SigninView {
  /** The machines host, said on the page every time: the only place the passphrase belongs. */
  host: string;
  /** The nonce from the handoff, when it can still be used. */
  nonce: string | null;
  /** Where to start the handoff again: the box's `/_gate/machines/handoff`. */
  handoffUrl: string;
  /** Machines are on but no passphrase is set yet. */
  notSetUp: boolean;
}

export function renderSignin(v: SigninView): string {
  const where = `<p class="gate-hint">Type the machines passphrase only into a tab whose address bar reads <strong>${escapeHtml(v.host)}</strong>. It is never asked for anywhere else.</p>`;
  if (v.notSetUp) {
    return page(
      "Machines · agentbox",
      `<section class="gate-card" aria-labelledby="gate-title">
<h1 id="gate-title" class="gate-title">Machines are not set up</h1>
<p class="gate-sub">No machines passphrase is set. On the server, run <code>sudo ./scripts/agentbox machines enable</code>.</p>
</section>`,
    );
  }
  if (v.nonce === null) {
    return page(
      "Sign in · machines",
      `<section class="gate-card" aria-labelledby="gate-title">
<h1 id="gate-title" class="gate-title">Sign in to machines</h1>
<p class="gate-sub">This sign-in link has expired or was already used.</p>
<p><a class="btn btn-primary gate-submit" href="${escapeHtml(v.handoffUrl)}" rel="noreferrer">Start again</a></p>
${where}
</section>`,
    );
  }
  return page(
    "Sign in · machines",
    `<section class="gate-card" aria-labelledby="gate-title">
<h1 id="gate-title" class="gate-title">Sign in to machines</h1>
<p class="gate-sub">on ${escapeHtml(v.host)}</p>
<form class="gate-form" id="machines-signin" method="post" action="/signin" data-restart="${escapeHtml(v.handoffUrl)}">
<input type="hidden" name="nonce" value="${escapeHtml(v.nonce)}">
<div class="field">
<label class="field-label" for="passphrase">Machines passphrase</label>
<input class="input" id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
</div>
${where}
<p class="gate-msg is-error" id="machines-message" role="alert" hidden></p>
<noscript><p class="gate-msg is-error">Signing in to machines needs JavaScript.</p></noscript>
<button class="btn btn-primary gate-submit" type="submit">Sign in</button>
</form>
</section>`,
  );
}

/** The Machines page: an empty shell the machines UI mounts into at `/`. */
export function renderMachinesShell(v: { host: string }): string {
  return page(
    "Machines · agentbox",
    `<section class="gate-card" aria-labelledby="gate-title" id="machines-root" data-host="${escapeHtml(v.host)}">
<h1 id="gate-title" class="gate-title">Machines</h1>
<p class="gate-sub">No machines are joined yet.</p>
<form id="machines-signout" method="post" action="/signout">
<button class="btn gate-submit" type="submit">Sign out of machines</button>
</form>
</section>`,
  );
}
