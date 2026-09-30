# agentbox as one app

Status: approved direction, September 2026. Supersedes the preview and sharing
parts of `2026-09-22-previews-installer-agents-design.md`; everything else in
the earlier designs stands.

## Why

agentbox's promise is: deploy it on a VPS, then develop and stage there — from a
browser, a phone or a laptop — as easily as on your own machine. Today it is
five tools on five paths (editor at `/`, Workbench at `/workbench`, herdr TUI,
shell and btop on ttyd), joined by nothing but a password popup. Three things
break the promise in daily use:

1. **Nothing feels connected.** Switching tools reloads them, nothing is shared
   between them, and there is no place that answers "what is going on in my
   box?".
2. **Previews do not work for real apps.** An app lives under a path prefix on
   the box's own origin inside an opaque sandbox. A Vite or Next dev server
   loads `/@vite/client` from the site root (which is the editor), module
   scripts from an opaque origin need CORS the proxy does not give, cookies are
   stripped, and HMR websockets are refused. A static page works; the React app
   an agent builds does not.
3. **Agents do not know where they are.** Nothing tells an agent that "preview"
   means the Workbench panel. Claude Code, signed in with a claude.ai account,
   has a claude.ai Artifact tool and reasonably took "put it in my preview" to
   mean that.

The operator chose path-based apps (no extra DNS) for their deployment, so this
design makes path-based apps as good as they can be, and gives the owner a
full-fidelity escape hatch through the local CLI (`agentbox forward`).

## The experience, worked backward

These journeys are the acceptance criteria for the whole design.

- **J1 — Arrive.** I open `https://work.example.com`. A login page in the app's
  own design (not a browser popup) asks for my password, and my 6-digit code if
  I turned two-factor on. I land on **Home**: what needs me (an agent waiting
  for input, a review to answer, an app that crashed), my projects, my running
  apps, and how the box is doing.
- **J2 — "Put it in my preview."** I ask an agent for a goofy React page in my
  preview. It scaffolds the app, runs `agentbox-preview start -- npm run dev`,
  and the dev server opens in the Preview dock on every open tab of mine, with
  a toast: "claude opened *goofy* in Preview". Editing a file updates the page
  (HMR). The dev server runs in a visible pane I can watch and stop.
- **J3 — Share / stage.** I press **Share** on the app, pick "anyone with the
  link, 7 days" (or add a passcode), and the app's own URL is copied — the same
  URL I was already looking at, now public. The Apps screen shows it as public
  with its expiry; **Stop sharing** makes it private again and cuts off anyone
  still connected. A pinned app comes back after the box restarts, so a staging
  link keeps working.
- **J4 — Files.** I drag a folder from my desktop onto **Files**, rename a file,
  download a directory as a zip, restore something from the trash, and jump
  from any file to "Open in editor", "Open a terminal here" or "Start an agent
  here".
- **J5 — Move around.** A rail switches between Home, Workbench, Editor, Files,
  Apps and System. Nothing reloads: the editor, the terminals and the preview
  stay live while I move. ⌘K finds any project, file, agent, app or action.
- **J6 — From my laptop.** `curl -fsSL https://work.example.com/cli/install | sh`
  installs `agentbox` and signs it in through my browser. Then
  `agentbox attach` puts the herdr TUI in my local terminal, `agentbox forward
  5173` makes the remote dev server `http://localhost:5173` on my laptop (full
  fidelity), `agentbox mount` shows the workspace in Finder, and `agentbox files
  put ./data -r` uploads a folder.
- **J7 — From my phone.** The same app with a bottom bar instead of a rail;
  agents, apps and files are usable one-handed.

## Architecture

```
browser / CLI
   │ HTTPS (Cloudflare → Traefik in traefik mode; Caddy TLS in standalone)
   ▼
 proxy  (Caddy: TLS where it terminates, compression, forwards everything)
   ▼
 gate   (NEW container, outside the sandbox)  :7900 public side, :7901 sandbox side
   │  login, sessions, 2FA, device tokens, CSRF, rate limits,
   │  app registry + visibility, all request routing and header policy
   ├──▶ code:8080  code-server            (/vscode/*)
   ├──▶ code:7681  ttyd herdr TUI         (/terminal*)
   ├──▶ code:7683  ttyd bash              (/shell*)
   ├──▶ code:7682  ttyd btop              (/monitor*)
   ├──▶ code:7800  bridge control plane   (/, /api/*, /ws/*)
   └──▶ code:7801  bridge data plane      (apps and tunnels only; gate-only)
 ┌──────────────── sandbox (uid 1000, unchanged boundary) ────────────────┐
 │ code-server · ttyd · bridge · herdr · agents · dev servers ("apps")    │
 └─────────────────────────────────────────────────────────────────────────┘
```

### The two rules

1. **Whatever decides who gets in lives outside the sandbox.** The bridge runs
   as the same user as every agent, so any state it holds an agent can change.
   Sessions, device tokens, the password hash, 2FA secrets and app visibility
   live in the gate's own volume, which the sandbox cannot read or write.
   Agents can register an app as *private*; only the owner's session or device
   token can make one public.
2. **No front-door credential ever enters the sandbox.** The gate strips its
   session cookie, app-grant cookies, `Authorization`, and share passcodes from
   every request it forwards. (Today Caddy forwards the basic-auth header — the
   password itself — to code-server and the bridge; a process in the sandbox
   that intercepted it would hold the box's login. This design removes that.)

A compromised sandbox can still publish itself through a tunnel of its own if
it has internet egress — that was always true and is stated in
`docs/security.md`. What agentbox guarantees is that its own front door never
publishes anything without the owner, never publishes agentbox's own services,
and never lets app content run with the box's origin.

### Ports and planes

| Listener | Who reaches it | Serves |
| --- | --- | --- |
| proxy :8080 | the internet (via Traefik/CF or directly) | forwards everything to gate :7900 |
| gate :7900 | proxy only (see client IPs below) | the public side: login, `/_gate/*`, `/cli/*`, `/a/<id>/*`, and authenticated routing |
| gate :7901 | the sandbox | the sandbox-side app API (register/list/update/remove private apps) |
| bridge :7800 | gate | the control plane: the SPA, `/api/*`, `/ws/*` |
| bridge :7801 | gate | the data plane: `/app/<port>/…` loopback proxy, `/tunnel/tcp/<port>`, `/tunnel/herdr` |

Splitting the bridge into two listeners makes "app content never reaches the
control-plane origin unsandboxed" a routing fact, not a path-matching one: the
gate is the only thing that talks to :7801, and it always wraps what comes back
in the app policy below.

The bridge must keep working for the in-sandbox CLIs (`agentbox-review`,
`agentbox-preview`), which call `http://127.0.0.1:7800` directly.

### Routing (gate, on the raw request URI)

The gate reuses the bridge's raw-path guard: any raw path with dot-segments,
`%2e`, `%2f`, `%5c`, a backslash, `;` or `//` in the routing prefix is refused
(400) before routing, so no normalisation difference between Caddy, the gate
and an upstream can move a request between branches.

| Path | Auth | Upstream |
| --- | --- | --- |
| `/login`, `/login/assets/*` | none | gate static (login page) |
| `/_gate/login`, `/_gate/device/start`, `/_gate/device/poll` | none (rate-limited) | gate |
| `/_gate/*` (everything else) | session or token | gate |
| `/cli/install`, `/cli/agentbox.mjs` | none | gate static (CLI bundle) |
| `/a/<id>/…` | app policy (below) | bridge :7801 `/app/<port>/…` |
| `/vscode/*` | session or token | code:8080, prefix stripped |
| `/terminal*`, `/shell*`, `/monitor*` | session or token | ttyd ports |
| everything else | session or token | bridge :7800 |

Unauthenticated: a navigation (`Sec-Fetch-Mode: navigate` or `Accept` preferring
HTML) gets `302 /login?next=<path>`; anything else gets `401`. `/workbench*`
redirects to the matching new route for old bookmarks.

## Front door

- **Login page.** Served by the gate, styled with the app's tokens. Username,
  password, "remember this device", then a 6-digit code if 2FA is on. Shows a
  calm, specific error; never says which of username or password was wrong.
- **Sessions.** Cookie `__Host-agentbox`: `HttpOnly; Secure; SameSite=Lax;
  Path=/`, an opaque random ID looked up in the gate's store. Idle timeout 12 h;
  "remember this device" gives 30 days absolute. Settings lists sessions (device,
  IP, last seen) and can end any of them, or all but this one. Changing the
  password or 2FA ends every other session.
- **Password.** The gate store is the source of truth. `AGENTBOX_PASSWORD_HASH`
  in `.env` only seeds a fresh store. Every way of setting the password — the
  installer's `--password`, `./scripts/agentbox passwd`, Settings → Account —
  writes the store (bcrypt, cost 14) and ends other sessions.
- **Two-factor (optional, recommended).** TOTP (RFC 6238), enrolled in Settings
  with a QR code and a confirmation code, plus 10 single-use recovery codes.
  `./scripts/agentbox totp reset` on the host is the escape hatch.
- **Rate limits and lockout, before bcrypt.** Per client IP: 5 login attempts a
  minute, then exponential backoff; 10 consecutive failures lock that IP out for
  15 minutes. A global ceiling of 30 attempts a minute. Unknown app IDs cost
  from the same per-IP budget (60 a minute), so IDs cannot be enumerated. Every
  mode gets this, not just Traefik.
- **Client IP.** The gate trusts forwarding headers only on connections from the
  proxy container; it reads `AGENTBOX_CLIENT_IP_HEADER` (default
  `CF-Connecting-IP` in traefik mode, empty = the proxy's `X-Forwarded-For`
  otherwise). The sandbox reaching :7900 directly is treated as any anonymous
  client.
- **CSRF.** Every non-GET/HEAD request on an authenticated route must carry an
  `Origin` equal to the box's own origin (host compared, as the WebSocket check
  does), or `Sec-Fetch-Site: same-origin`; otherwise 403. Bearer-token requests
  are exempt (no ambient credential). WebSocket upgrades on control-plane
  routes keep the host-equality Origin check.
- **Device tokens (for the CLI).** OAuth-style device flow:
  1. `POST /_gate/device/start {name}` → `{deviceCode, userCode, verifyUrl,
     interval, expiresIn}` (userCode `XXXX-XXXX`, 10 minutes).
  2. The CLI opens `verifyUrl` (`/settings/devices?code=XXXX-XXXX`); the owner,
     signed in, sees "Allow *agentbox CLI on jabe-laptop* full access?" and
     approves.
  3. `POST /_gate/device/poll {deviceCode}` → `{token}` once approved.
  Tokens are 256-bit, prefixed `abx_`, stored hashed (SHA-256) with name,
  created, last used and last IP; listed and revocable in Settings → Devices.
  They are sent as `Authorization: Bearer` and accepted on every authenticated
  route, including ttyd and tunnels.
- **Headers on everything the gate serves:** `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options: nosniff`, `frame-ancestors 'self'` on control-plane
  HTML. HSTS stays with the TLS terminator.

## Apps

An **app** is a dev server (or any HTTP server) running in the sandbox, with one
URL: `/a/<id>/`. The id is 26 lowercase base32 characters (128 random bits).

### The record (gate store)

```ts
interface App {
  id: string;              // 26 chars [a-z2-7]
  name: string;            // "goofy", editable
  port: number;            // loopback port in the sandbox
  keepPrefix: boolean;     // app was configured with base /a/<id>/ (forward the full path)
  cwd?: string;            // where it was started
  command?: string;        // how to start it again
  pinned: boolean;         // relaunch when the box starts ("staging")
  createdBy: "owner" | "agent";
  createdAt: number;
  visibility: {
    mode: "private" | "link" | "passcode";
    expiresAt: number | null;   // null = until stopped
    passcodeHash?: string;      // bcrypt
    sharedAt?: number;
  };
  compat: "auto" | "off";  // the path-fidelity layer below
}
```

Infrastructure ports (8080, 7681, 7682, 7683, 2222, 7800, 7801, 7900, 7901 and any
the operator adds) are refused at registration, update and serve time, by the
gate.

### Who may open `/a/<id>/…`

1. The request carries a valid **app grant** for this id → allow.
2. The request carries a valid **session or device token** → allow, and on a
   navigation mint an app grant.
3. The app is `link` and unexpired → allow as public.
4. The app is `passcode` and unexpired → serve the gate's passcode page; a
   correct passcode mints an app grant (rate-limited like login).
5. Otherwise → navigation: `302 /login?next=…`; anything else: `404` (the same
   answer as an unknown id, so private and nonexistent look alike).

The **app grant** is cookie `__Secure-agentbox-app`: `Path=/a/<id>/; HttpOnly;
Secure; SameSite=None`, an HMAC-signed `{appId, subject, exp}` (subject = the
session, token or passcode unlock; revoking the subject or changing visibility
invalidates it). `SameSite=None` because app documents have an opaque origin,
so every request they make is cross-site; the cookie is path-scoped to one app
and grants nothing else.

**Font exemption.** `@font-face` loads are CORS requests without credentials,
so a private app's own fonts would never carry the grant. A `GET` whose path
ends in `.woff2|.woff|.ttf|.otf` to an existing app id is served without a
grant *only if* the upstream answers with a font content type; anything else is
a 404. The worst a leaked private id yields is a font file.

**Revocation and expiry** (to private, or deleting the app) end every open
connection that was admitted as public or by passcode, and invalidate grants
minted from them. Expiry is swept every 30 seconds.

### The app policy (applied by the gate to every `/a/` exchange)

- **Opaque origin always.** Every response carries `Content-Security-Policy:
  sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads`
  (added alongside any policy the app sets). The dock iframe carries the same
  `sandbox` attribute. What the owner sees in the dock is exactly what a viewer
  sees in a new tab.
- **Strip from the request:** `__Host-agentbox`, `__Secure-agentbox-app`,
  `Authorization`, and the passcode form fields; the app's own cookies pass.
- **Strip from the response:** `Service-Worker-Allowed`, `Clear-Site-Data`,
  `Strict-Transport-Security`, `Set-Cookie` for our cookie names.
- **Cookies work.** The app's `Set-Cookie` is rewritten: `Domain` removed,
  `Path` prefixed with `/a/<id>`, `SameSite=None; Secure` forced. Server-side
  sessions (an app's own login) therefore work in the dock and when shared.
- **CORS for its own opaque origin.** A request with `Origin: null` gets
  `Access-Control-Allow-Origin: null`, `Access-Control-Allow-Credentials: true`,
  `Vary: Origin`; CORS preflights (`OPTIONS` + `Access-Control-Request-Method`)
  from `Origin: null` are answered by the gate (echo method and headers,
  `max-age` 600). This is what makes module scripts, `fetch` and fonts load.
- **WebSockets.** Upgrades on `/a/<id>/` accept `Origin: null` or the box's own
  origin (the grant/public decision above already applies). HMR works.
- **Upstream normalisation** (done by the bridge data plane): `Host` →
  `127.0.0.1:<port>`, `Origin`/`Referer` → `http://127.0.0.1:<port>…`, so dev
  servers' host and origin checks (Vite `allowedHosts`, Next dev origin checks)
  see a local request. `Location` (root-relative or `http://localhost:<port>`)
  is rewritten into `/a/<id>/`.
- **Fallback page.** If nothing answers, a navigation gets the branded "Nothing
  is serving on port N" page with Retry (existing behaviour, kept in the data
  plane: navigation-only, only before the first byte, never replacing a
  response the app sent). Upstream errors the app actually sent pass through.

### Path fidelity (`compat: "auto"`)

An app mounted at `/` that is served under `/a/<id>/` must still work. The gate
applies these to HTML responses (requested upstream with
`Accept-Encoding: identity` so they can be edited; streaming preserved for
everything else):

1. **HTML rewrite.** Root-absolute `src`, `href`, `action`, `srcset`, `poster`
   and `formaction` values (`/x`, not `//x`, not already under `/a/<id>/`) are
   prefixed. `<script type="module">` and `<link rel="modulepreload">` get
   `crossorigin="use-credentials"`, so the whole module graph carries the grant.
2. **Import map.** Before the first module script:
   `{"imports": {"/": "/a/<id>/", "/a/<id>/": "/a/<id>/"}}` — root-absolute
   module specifiers (`import "/@vite/client"`, `/node_modules/.vite/deps/…`)
   resolve under the app. Skipped (with a hint) if the page brings its own.
3. **Runtime shim** (`/a/<id>/__agentbox/shim.js`, first script in `<head>`):
   - root-absolute URLs are prefixed in `fetch`, `XMLHttpRequest.open`,
     `WebSocket`, `EventSource`, `Worker`, `history.pushState/replaceState`,
     `location.assign/replace`, and the `src`/`href`/`action` property setters
     and `setAttribute` on media, link, script, anchor, form and iframe
     elements;
   - `fetch`, XHR and `EventSource` to the app default to credentials `include`;
   - where the opaque origin makes them throw, `localStorage`,
     `sessionStorage` and `document.cookie` are replaced with in-memory
     equivalents, so apps that touch them run (state resets on reload).
4. **CSS.** `url(/…)` in `text/css` responses is prefixed.
5. **Hint.** If an HTML response still references root-absolute paths the layer
   could not reach (e.g. a framework that hard-codes its origin), the dock shows
   one line: "This app assumes it runs at `/`. Start it with `agentbox-preview`
   or set its base path to `/a/<id>/`" with a copy button.

`compat: "off"` passes HTML through untouched (for apps configured with the
base path, or where the layer misbehaves); the panel exposes it as "Path fixes".
When `keepPrefix` is true the gate forwards `/a/<id>/x` to the upstream as
`/a/<id>/x`; otherwise as `/x`.

**Known limits, stated in the docs and the dock's info popover:** no service
workers, no IndexedDB, and browser storage resets on reload (opaque origin);
apps that hard-code their absolute origin; engines that block `SameSite=None`
cookies for opaque top-level documents may lose a *private* app's grant when it
is opened full screen (public apps are unaffected). For anything that needs
full fidelity, `agentbox forward <port>` from the CLI serves it at
`http://localhost:<port>` on the owner's machine.

### Sandbox-side app API (gate :7901)

`POST /apps {port, name?, cwd?, command?, pinned?, keepPrefix?}` → `App`
(always private, `createdBy: "agent"`); `GET /apps`; `GET /apps/:id`;
`PATCH /apps/:id {name?, port?, cwd?, command?, pinned?, keepPrefix?, compat?}`;
`DELETE /apps/:id`. Visibility is not writable here. The bridge proxies these
as `/api/apps*` for the SPA and the in-sandbox CLI, merging each record with
live state from its port watcher (listening? pid, process cwd, the herdr pane
that owns it).

Owner-only (`/_gate/apps/:id/visibility`, `PUT {mode, expiresIn?, passcode?}`,
`DELETE` = stop sharing) lives on the public side and is refused to anything
but a session or device token.

### Pinned apps

On start the bridge relaunches every pinned app that has a `command` and `cwd`,
in a herdr tab named after the app in an **Apps** workspace, and waits for its
port. Pinning plus a non-expiring link is the staging story.

## Agents know the box

- **Standing instructions, always loaded.**
  - Claude Code: the managed policy memory file
    (`/etc/claude-code/CLAUDE.md` on Linux — verify the path against current
    Claude Code docs), baked into the image so it updates with the image.
  - Codex: a marked block in `~/.codex/AGENTS.md`, written by the entrypoint on
    every start, preserving anything outside the markers.
  - Content (short): you are in agentbox; the user sees your work in the
    browser; "preview"/"put it in my preview" means the Preview dock — start the
    server with `agentbox-preview start` and it appears there; bind to
    `127.0.0.1` (or `0.0.0.0`) on any free port; never make an app public
    (only the user can) and never use claude.ai Artifacts or external hosting
    to show a web app unless the user explicitly asks; for a plan, comparison
    or report use `agentbox-review`; files the user should get go in
    `/workspace`.
- **Skills.** `preview` (new): the loop, framework base-path recipes (Vite
  `--base`, Next `basePath`, Astro `--base`, SvelteKit `paths.base`, CRA
  `PUBLIC_URL`), troubleshooting from the dock's hint. `review` updated to point
  at `preview` for running apps.
- **`agentbox-preview`** (in-sandbox CLI, dependency-free Node like
  `agentbox-review`, talking to the bridge on 127.0.0.1:7800):
  - `start [--name n] [--port p] [--cwd d] [--pin] -- <command…>`: registers the
    app, chooses a free port if none is given, launches the command in a herdr
    tab (the calling agent's workspace when it can be identified, else
    **Apps**) with `PORT`, `HOST=127.0.0.1` and `AGENTBOX_BASE_PATH=/a/<id>/`
    set; for Vite it appends `--base /a/<id>/ --port <p> --strictPort --host
    127.0.0.1` and records `keepPrefix: true`; waits until the port answers;
    opens it in the owner's dock; prints the URL and id. Exit codes: 0 ready,
    1 error, 5 the server never came up (with the last lines of its output).
  - `open <port|id>` (register if needed, then show in the dock), `list`,
    `stop <id>` (stop the process and remove the app), `url <id>`,
    `static <dir>` (serve a folder with a built-in static server as an app).
  - No `share`: making something public is the user's.
- **Opening in the dock.** The bridge's events socket gains `app.open {id,
  by}` (every open tab switches its dock to the app and shows a toast) and
  `apps.changed`.

## The one app (shell)

The Workbench SPA becomes the whole app, served by the bridge at `/`.

- **Frame.** A narrow rail (icons with labels on hover, and a keyboard
  shortcut for each, chosen to avoid browser-reserved and VS Code default
  bindings): **Home,
  Workbench, Editor, Files, Apps, System**; Settings and the connection pill at
  the bottom. On narrow screens the rail becomes a bottom bar (Home, Workbench,
  Files, Apps, More).
- **Surfaces stay mounted.** Switching hides a surface; it never unmounts it.
  The editor iframe is created on first visit and kept; terminal streams stay
  connected.
- **Dock.** Preview and Review move out of the Workbench into a right-hand dock
  available on every surface (a toggle shortcut, resizable, remembered per
  surface).
  Preview: app picker, path bar within the app, reload, open full screen,
  device widths (phone/tablet/desktop), the Share control, the fidelity hint,
  and "Open on your machine" (shows the `agentbox forward` command).
- **Routes.** `/` Home, `/workbench`, `/editor`, `/files/*path`, `/apps`,
  `/apps/:id`, `/system`, `/settings/:section`. Deep links work on reload.
  The API moves from `/workbench/api` to `/api`, sockets to `/ws`.
- **⌘K palette** spans everything: surfaces, projects, files (name search),
  agents, apps, reviews and actions. Inside the editor, where VS Code owns ⌘K,
  the palette and surface switch are reached with combos VS Code does not bind
  by default (the shell listens on the same-origin editor iframe's window).
- **Design.** The rubl-derived tokens and components already in the app;
  light/dark/system theme; the login, passcode and fallback pages share the
  tokens.

### Surfaces

- **Home.** *Needs you* (agents waiting or done, reviews awaiting an answer,
  crashed pinned apps) → one click to the thing. *Projects*: a card per
  top-level directory of `/workspace` — git branch, uncommitted count,
  ahead/behind, last change, agents working in it (panes whose cwd is inside),
  apps it runs (listeners whose process cwd is inside), and actions (Editor,
  Files, Terminal here, New agent here). *New project*: clone a Git URL, or an
  empty folder. *Apps*: running apps with visibility badges. *System strip*:
  CPU, memory, disk.
- **Workbench.** Today's herdr client (workspaces, tabs, panes, agents,
  composer), unchanged in behaviour, minus its brand header and the inspector
  (now the dock).
- **Editor.** code-server at `/vscode/`, framed and kept alive. A small VS Code
  extension baked into the image (`agentbox-connect`) connects to the bridge
  (`/ws/editor`, same network namespace) so "Open in editor" from anywhere opens
  the file (and line) in the running editor and brings the surface forward.
- **Files.** See below.
- **Apps.** Every app: name, id, port, status (listening / not up), pane,
  created by, visibility and expiry, pin; actions: open in dock, open full
  screen, share / stop sharing, restart (for apps with a command), stop,
  rename, path-fix toggle, delete. Unregistered listening ports appear under
  "Also listening" with a one-click "Make an app".
- **System.** Sandbox CPU and memory against their limits (cgroup v2), PIDs,
  disk for the workspace and home volumes, uptime, top processes, listening
  ports, versions (agentbox, herdr, code-server, each agent CLI). "Detailed
  monitor" embeds `/monitor` (btop).
- **Settings.** Account (password, 2FA, sessions), Devices & CLI (tokens,
  pending device approvals, the install command), Sharing (default expiry,
  every public app in one list), Appearance, About.

## Files

Bridge control-plane API, rooted at `/workspace` (a second root, Home
`/home/coder`, is available but hidden by default). Every path is resolved with
`realpath` and must stay inside its root; writes never follow a symlink out of
it.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/files/list?path=&hidden=` | entries: name, path, type, size, mtime, symlink target, git status |
| `GET /api/files/stat?path=` | one entry |
| `GET /api/files/raw?path=&inline=` | download; `inline` only for images, PDF, plain text — always with `Content-Security-Policy: sandbox` and `nosniff`; HTML and SVG are never served inline as active content |
| `GET /api/files/zip?path=…` | a streamed zip of one or more paths |
| `POST /api/files/uploads {path, size, overwrite}` → `{uploadId}` | start a chunked upload |
| `PUT /api/files/uploads/:id?offset=` | a chunk, ≤ 50 MiB (under Cloudflare's 100 MB request cap) |
| `POST /api/files/uploads/:id/finish` | atomic rename into place |
| `POST /api/files/write {path, content}` | small text writes (new file) |
| `POST /api/files/mkdir|move|copy {…}` | directory, rename/move, copy |
| `POST /api/files/trash {paths}` · `GET /api/files/trash` · `POST /api/files/trash/:id/restore` · `DELETE /api/files/trash/:id` | trash in `/workspace/.agentbox/trash` with restore metadata; permanent deletion only from the trash |
| `GET /api/files/search?q=` | file-name search (fd) for the palette |
| `/api/dav/*` | WebDAV over the same root, for `agentbox mount` |

The Files surface: tree + list with breadcrumbs, multi-select, drag to move,
drop to upload (files and folders, with progress and cancel), download (file or
zip), new file/folder, rename (F2), trash with an undo toast, a Trash view,
quick look (text/code, rendered Markdown, images, PDF), git status marks, and
per-item actions: Open in editor, Terminal here, New agent here, Copy path,
Download, Serve this folder as an app.

## The local CLI (`agentbox`)

A single-file Node (≥ 20) program, `web/cli`, bundled with its dependencies.

- **Install.** The box serves its own matching build: `curl -fsSL
  https://<box>/cli/install | sh` installs to `~/.local/bin/agentbox` (checks
  Node, prints how to add it to `PATH`) and runs `agentbox login <box>`.
  `npm i -g ./web/cli` works from a checkout. `agentbox update` re-downloads
  from the box; the CLI warns when its version differs from the box's.
- **Config.** `~/.config/agentbox/config.json` (0600): named boxes (`url`,
  token), the current one. `--box <name>` on any command; `agentbox use
  <name>`, `agentbox boxes`.
- **Commands** (`--json` on every read command):

| Command | What it does |
| --- | --- |
| `login <url> [--name]` · `logout` · `whoami` | device flow; revokes the token on logout |
| `status` | box health, agents and their states, apps, system |
| `open [surface\|path]` | opens the app in the browser |
| `attach` | the herdr TUI in this terminal (ttyd `/terminal` protocol) |
| `shell [--cwd]` | a bash shell (ttyd `/shell`) |
| `forward <port>[:<local>] …` | TCP forwarding over a WebSocket tunnel; prints `http://localhost:<local>` |
| `herdr call <method> [json]` · `herdr socket [path]` | raw herdr RPC; a local Unix socket that speaks herdr's protocol to the remote server |
| `files ls\|get\|put\|rm\|mv\|cp\|mkdir\|cat\|edit` | with `-r`, progress and chunked uploads; `edit` round-trips through `$EDITOR` |
| `mount [dir]` | a local WebDAV front on `127.0.0.1` behind a random path secret, mounted with the OS (macOS `mount_webdav`, Linux `gio mount`, Windows `net use`); `--no-mount` prints the URL |
| `apps ls\|open\|share\|unshare\|forward` | the app model from the terminal; `share --expires 7d --passcode` |
| `agents ls` · `review ls\|open` | what is running and what awaits you |
| `update` | self-update from the box |

- **Tunnels.** `GET /_gate/tunnel?target=tcp:<port>|herdr` (WebSocket, bearer
  token only) → the gate connects to bridge :7801 `/tunnel/tcp/<port>` or
  `/tunnel/herdr`, which pipe bytes to `127.0.0.1:<port>` or the herdr socket.
  Infrastructure ports are allowed here (the token holder is the owner) — that
  is how `forward 8080` reaches the editor directly if wanted. Keepalive pings
  every 25 s (Cloudflare drops idle sockets at 100 s).
- **Terminal.** Raw mode, resize on `SIGWINCH`, `Ctrl-]` then `q` to detach
  locally; exits with the remote process.

## Installer and migration

- `docker-compose.yml` gains `gate` (image `agentbox/gate`, built from
  `images/gate/Dockerfile` at the repo root; non-root, `cap_drop: ALL`,
  `no-new-privileges`, read-only root filesystem, tmpfs `/tmp`, volume
  `agentbox_gate:/data`, `internal` network, CPU/memory caps, healthcheck). The
  proxy loses `basic_auth` in every mode and forwards to `gate:7900`;
  `AGENTBOX_PASSWORD_HASH` and `AGENTBOX_USER` move to the gate.
- **Removed:** hostname previews (`--preview-domain`,
  `docker-compose.previews.yml`, `Caddyfile.previews`, the on-demand-TLS ask
  endpoint), `/workbench/preview/<port>`, and `/s/<token>`. Path apps replace
  both, and "an apps domain" can return later as another URL shape of the same
  app model.
- `--preview off|path` becomes `--sharing on|off` (the old flag is accepted as
  an alias). New: `./scripts/agentbox passwd`, `./scripts/agentbox totp
  reset`. The installer prints the CLI install line at the end.
- Fold in the known minors: `ExecStop=-` in the egress unit, the isolate-host
  self-check probing a port that is really listening, never writing
  `https://localhost` as the public URL.
- **Existing installs** (including the live box): `update` builds and starts the
  gate, seeds it from the current hash, and switches the proxy config. The
  first visit after the update shows the login page instead of the popup.
  Existing `/s/` links stop working (they were 24 h anyway).

## Security model changes (for `docs/security.md`)

Rewrite the Workbench and authentication sections around the two rules above:
the gate as the only decider; credential stripping; the app policy (opaque
origin always, cookies path-scoped and forced `SameSite=None`, CORS for its own
null origin, the font exemption and why it is bounded); device tokens and their
scope; the sandbox-side app API's limits; the data-plane listener as a routing
boundary; rate limits in every mode; the residual (a sandbox with egress can
publish itself; `SameSite=None` grants and full-screen private apps).

## Testing and verification

- **Unit/integration** (vitest) per package: gate (sessions, lockout, TOTP,
  device flow, CSRF, routing table, app policy header transforms, HTML
  rewrite, cookie rewrite, grant minting and revocation), bridge (data plane,
  files, system, projects, editor channel), app (surfaces, routing, dock,
  palette), CLI (argument parsing, config, tunnels against a local server).
- **Gate bypass suite** (successor of `tests/proxy/share-bypass.sh`): the real
  proxy config + real gate + real bridge in containers; unauthenticated
  requests with every known path trick must never reach a control-plane
  upstream, `/vscode`, ttyd, or a private app; our cookies and `Authorization`
  never arrive upstream (an echo server as the "sandbox" asserts it).
- **Fidelity suite** (Playwright, Chromium + Firefox + WebKit): a real
  `create-vite` React-TS dev server (fixture checked in, dependencies cached)
  (a) started with `agentbox-preview start` and (b) started plainly with
  `npm run dev` — both render in the dock, HMR applies an edit, the default
  template's image loads; a tiny app using `localStorage` and `document.cookie`
  does not crash; an app with a cookie login works private and shared; a shared
  link works logged out; stopping sharing cuts a connected viewer.
- **End to end** (Playwright against the full compose stack): login (with and
  without 2FA), every journey J1–J5, mobile viewport for J7.
- **CLI end to end** against the local stack: login via device flow (approved
  through the browser), `status`, `attach` (sees the herdr UI), `forward`
  (curl through it), `files` round trip, `mount --no-mount` with a WebDAV
  client, `apps share/unshare`.
- **Live verification** on the deployed box: the journeys in a real browser via
  Cloudflare, the CLI from this laptop, other stacks on the host untouched.

## Out of scope (later)

An apps domain (`<id>.apps.example.com`) as an alternative URL shape; custom
app slugs; rotating an app's id; multiple users and roles; native CLI binaries
and Homebrew; syncing folders (use `mount` or `files`).
