import { escapeHtml } from "../pages.js";
import type { AuditEvent } from "./audit.js";
import type { ClaudeTokenStatus } from "./claude-token.js";
import type { JoinView } from "./joins.js";
import type { MachineView } from "./registry.js";

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

/**
 * The machines UI (web/app's second entry): its own files only, as the
 * sign-in. Styles may be set inline (the terminal sets its own), script never.
 * It frames one thing: a machine's app, on the machine-apps origin (Preview).
 */
export function machinesUiCsp(appsHost: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src https://${appsHost}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "worker-src 'none'",
  ].join("; ");
}

/** Where the machines pages' files are served (machines host only). */
export const MACHINES_ASSETS = "/_gate/machines/assets";

function page(title: string, body: string, wide = false): string {
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
<main class="gate${wide ? " gate-wide" : ""}">
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

const STATE_LABEL: Record<MachineView["state"], string> = {
  online: "online",
  offline: "offline",
  paused: "paused on the machine",
  revoked: "revoked",
  left: "left",
};

function when(t: number | null): string {
  return t === null ? "never" : new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function gib(bytes: number): string {
  return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
}

function specsLine(m: MachineView): string {
  const s = m.specs;
  if (!s) return `${escapeHtml(m.reported.platform)}/${escapeHtml(m.reported.arch)} · ${escapeHtml(m.reported.hostname)}`;
  const parts = [
    `${s.platform}/${s.arch}`,
    s.hostname,
    `node ${s.version}`,
    `${s.cpu.cores} × ${s.cpu.model || "CPU"}`,
    `${gib(s.ramBytes)} RAM`,
    ...s.gpus.map((g) => `GPU ${g.name}${g.memoryMiB ? ` (${g.memoryMiB} MiB)` : ""}`),
    s.docker ? "Docker" : "no Docker",
    s.claude ? `Claude Code ${s.claude}` : "no Claude Code",
  ];
  return parts.map(escapeHtml).join(" · ");
}

function policyLine(m: MachineView): string {
  const p = m.specs?.policy;
  if (!p) return "";
  if (p.problem) return `<span class="gate-msg is-error">policy: ${escapeHtml(p.problem)} (everything denied)</span>`;
  const folders = p.files.map((f) => `${f.path} (${f.mode})`).join(", ") || "no folders";
  return escapeHtml(`terminals ${p.terminals ? "on" : "off"} · ${folders} · ports ${p.ports ? "on" : "off"} · presence ${p.presenceHours} h`);
}

function machineItem(m: MachineView, manage: boolean): string {
  const free = m.specs?.disks.map((d) => `${d.path}: ${gib(d.freeBytes)} free`).join(", ") ?? "";
  const optIn = m.optIns.claudeToken;
  const actions = !manage
    ? ""
    : m.state === "revoked" || m.state === "left"
      ? `<button class="btn" type="button" data-machines-post="/_gate/machines/m/${escapeHtml(m.id)}/remove" data-confirm="Remove ${escapeHtml(m.name)} from the list? Its token will be unknown from now on.">Remove</button>`
      : `<button class="btn" type="button" data-machines-post="/_gate/machines/m/${escapeHtml(m.id)}/opt-in" data-body="${escapeHtml(JSON.stringify({ claudeToken: !optIn }))}">${optIn ? "Stop sharing the Claude sign-in" : "Share the Claude sign-in"}</button>
<button class="btn" type="button" data-machines-post="/_gate/machines/m/${escapeHtml(m.id)}/revoke" data-confirm="Revoke ${escapeHtml(m.name)}? Its link ends now and it stops. If it had the shared Claude token, replace that token afterwards.">Revoke</button>`;
  return `<li class="machine" data-machine="${escapeHtml(m.id)}" data-state="${m.state}">
<div class="machine-head"><strong>${escapeHtml(m.name)}</strong> <span class="machine-state is-${m.state}">${STATE_LABEL[m.state]}</span></div>
<div class="gate-hint">${specsLine(m)}</div>
${free ? `<div class="gate-hint">${escapeHtml(free)}</div>` : ""}
${policyLine(m) ? `<div class="gate-hint">${policyLine(m)}</div>` : ""}
<div class="gate-hint">last seen ${escapeHtml(when(m.lastSeenAt))}${m.lastIp ? ` from ${escapeHtml(m.lastIp)}` : ""} · id ${escapeHtml(m.id)}</div>
${m.duplicateAt ? `<div class="gate-msg is-error">A second link for this machine was refused at ${escapeHtml(when(m.duplicateAt))}: is its token copied elsewhere?</div>` : ""}
${m.upgradeNeeded ? `<div class="gate-msg is-error">Update needed: this machine's node is too old for the box.</div>` : ""}
${manage && m.state !== "revoked" && m.state !== "left" ? `<div class="gate-hint">Shared Claude sign-in: ${optIn ? "on" : "off"}</div>` : ""}
${manage && m.claudeTokenStale ? `<div class="gate-msg is-error">This machine has not had the current Claude token yet (it is offline); agents it runs still use the old one.</div>` : ""}
${actions}
</li>`;
}

function machineList(machines: MachineView[], manage: boolean): string {
  if (machines.length === 0) return `<p class="gate-sub">No machines are joined yet.</p>`;
  return `<ul class="machines">${machines.map((m) => machineItem(m, manage)).join("\n")}</ul>`;
}

/** The Machines page at `/` when the machines UI is not built (a gate built alone): the list. */
export function renderMachinesShell(v: { host: string; machines: MachineView[] }): string {
  return page(
    "Machines · agentbox",
    `<section class="gate-card" aria-labelledby="gate-title" id="machines-root" data-host="${escapeHtml(v.host)}">
<h1 id="gate-title" class="gate-title">Machines</h1>
${machineList(v.machines, false)}
<p><a class="btn" href="/admin">Admin: join, revoke, audit</a></p>
<form id="machines-signout" method="post" action="/signout">
<button class="btn gate-submit" type="submit">Sign out of machines</button>
</form>
</section>`,
    true,
  );
}

export interface AdminView {
  host: string;
  /** The box's own hostname, which `node join` is given. */
  box: string;
  machines: MachineView[];
  joins: JoinView[];
  audit: AuditEvent[];
  claudeToken: ClaudeTokenStatus;
}

function claudeSection(v: AdminView): string {
  const t = v.claudeToken;
  const stale = v.machines.filter((m) => m.claudeTokenStale);
  const state = t.set
    ? `<p class="gate-sub">A token is set (since ${escapeHtml(when(t.setAt))}). It is never shown again; paste a new one to replace it.</p>`
    : `<p class="gate-sub">No token is set. Machines that are not given one sign Claude Code in on their own (<code>/login</code> in the machine's terminal).</p>`;
  return `<section class="gate-card" aria-labelledby="claude-title">
<h2 id="claude-title" class="gate-title">Claude Code sign-in</h2>
<p class="gate-hint">On any computer, run <code>claude setup-token</code> and paste the token here. It goes only to machines you share it with (below), and is read by Claude Code on each launch.</p>
${state}
<form class="gate-form" id="machines-claude-token" method="post" action="/_gate/machines/claude-token">
<div class="field">
<label class="field-label" for="claude-token">${t.set ? "Replace the token" : "Token"}</label>
<input class="input" id="claude-token" name="token" type="password" autocomplete="off" spellcheck="false" required>
</div>
<p class="gate-msg is-error" id="claude-token-message" role="alert" hidden></p>
<button class="btn btn-primary gate-submit" type="submit">${t.set ? "Replace" : "Save"}</button>
</form>
${t.set ? `<p><button class="btn" type="button" data-machines-post="/_gate/machines/claude-token/remove" data-confirm="Remove the shared Claude token? Machines that have it are told to delete it.">Remove the token</button></p>` : ""}
${
  stale.length
    ? `<p class="gate-msg is-error">Still on the old token (offline since it changed): ${stale.map((m) => escapeHtml(m.name)).join(", ")}. Agents running anywhere keep the token they started with until restarted.</p>`
    : t.set
      ? `<p class="gate-hint">Agents started before the token last changed keep the one they started with until restarted.</p>`
      : ""
}
</section>`;
}

/** The Admin page: pending joins (approved by typing the code the machine shows), machines, the audit log. */
export function renderAdmin(v: AdminView): string {
  const joins = v.joins.length
    ? `<ul class="machines">${v.joins
        .map(
          (j) => `<li class="machine" data-join="${escapeHtml(j.id)}">
<div class="machine-head"><strong>${escapeHtml(j.name)}</strong>${j.rejoinOf ? " (re-joining in place)" : ""}</div>
<div class="gate-hint">${escapeHtml(`${j.platform}/${j.arch} · ${j.hostname}`)} · asked from <strong>${escapeHtml(j.ip)}</strong> · expires ${escapeHtml(when(j.expiresAt))}</div>
<button class="btn" type="button" data-machines-post="/_gate/machines/joins/deny" data-body="${escapeHtml(JSON.stringify({ id: j.id }))}">Deny</button>
</li>`,
        )
        .join("\n")}</ul>`
    : `<p class="gate-sub">No machine is waiting to join.</p>`;
  const audit = v.audit.length
    ? `<ol class="audit">${v.audit
        .map(
          (e) =>
            `<li><span class="gate-hint">${escapeHtml(when(e.at))}</span> ${escapeHtml(e.kind)}${e.name ? ` <strong>${escapeHtml(e.name)}</strong>` : ""}${e.ip ? ` from ${escapeHtml(e.ip)}` : ""}${e.detail ? ` — ${escapeHtml(e.detail)}` : ""}</li>`,
        )
        .join("\n")}</ol>`
    : `<p class="gate-sub">Nothing yet.</p>`;
  return page(
    "Admin · machines",
    `<section class="gate-card" aria-labelledby="gate-title" id="machines-admin" data-host="${escapeHtml(v.host)}">
<h1 id="gate-title" class="gate-title">Machines admin</h1>
<p><a href="/">Back to machines</a></p>
</section>
<section class="gate-card" aria-labelledby="joins-title">
<h2 id="joins-title" class="gate-title">Join a machine</h2>
<p class="gate-hint">On the machine, run <code>agentbox node join https://${escapeHtml(v.box)}</code>. It shows a code: type that code here. Approve only a machine whose name, platform and address you recognise.</p>
${joins}
<form class="gate-form" id="machines-approve" method="post" action="/_gate/machines/joins/approve">
<div class="field">
<label class="field-label" for="join-code">Code shown on the machine</label>
<input class="input" id="join-code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" required placeholder="XXXX-XXXX">
</div>
<p class="gate-msg is-error" id="machines-message" role="alert" hidden></p>
<button class="btn btn-primary gate-submit" type="submit">Approve</button>
</form>
</section>
<section class="gate-card" aria-labelledby="list-title">
<h2 id="list-title" class="gate-title">Machines</h2>
${machineList(v.machines, true)}
</section>
${claudeSection(v)}
<section class="gate-card" aria-labelledby="audit-title">
<h2 id="audit-title" class="gate-title">Audit log</h2>
${audit}
</section>`,
    true,
  );
}
