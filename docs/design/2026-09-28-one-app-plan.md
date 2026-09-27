# agentbox as one app — implementation plan

> **For agentic workers:** this plan is executed **one agent per phase**, not
> task by task. Each phase lists its outcome, what it must deliver, the
> interfaces it produces and consumes, and a definition of done. Plan your own
> steps inside the phase, test-first where it fits (vitest, Playwright, shell
> tests), and commit as you go in small, reviewable commits. Read the spec
> first; this plan argues from it.

**Goal:** Turn agentbox into one integrated app. A gate outside the sandbox
guards it, path apps work for real dev servers and can be shared, agents know
how to use the preview, there is a file manager, and a local CLI reaches
everything from a laptop.

**Architecture:** A new `gate` service (Node/Fastify, own container) replaces
Caddy's basic auth. It routes every request, holds all front-door state, and
applies the app policy on `/a/<id>/`. The bridge splits into a control plane
(:7800) and a data plane (:7801, gate-only). The React app moves to `/` and
becomes a shell of surfaces with a global dock. A new `web/cli` package ships
from the box itself.

**Tech stack:** Node 22, TypeScript, Fastify 5, React 19, Vite, zustand,
xterm.js, vitest, Playwright (Chromium, Firefox, WebKit), Caddy 2, Docker
Compose, bash.

**Spec:** `docs/design/2026-09-28-one-app-design.md`.

## Global constraints

- Node ≥ 22 for server packages; the CLI runs on Node ≥ 20.
- Commits: imperative subject, and a body that says why. **Never** add
  `Co-Authored-By` or "Generated with" lines. The repository is public.
- Match the surrounding code: naming, comment density, idiom. Colours only
  through `web/app/src/theme/tokens.css` tokens.
- The two rules hold at every commit:
  1. Whatever decides who gets in lives outside the sandbox.
  2. No front-door credential ever enters the sandbox.
- Every behaviour change updates its documentation (`README.md`,
  `docs/install.md`, `docs/workbench.md`, `docs/security.md`) in the same phase.
- Existing tests stay green: `cd web && npm test && npm run typecheck && npm run lint`,
  `npm run e2e -w app`, the shell tests under `tests/`, shellcheck, and compose
  and Caddy validation as CI runs them. Update `.github/workflows/ci.yml` when
  you add or replace a suite.
- Images are never built on the production host. No phase touches other stacks
  on that host.

## Schedule

```
wave 1:  A Gate ─────────────┐        B Bridge backend + move to / ──┐
wave 2:  C Apps & agents ◀───┴───────────────┐   D The one app ◀─────┤ (D rebases on C)
wave 3:  E Local CLI ◀─── needs A, B, C ─────┘                        │
wave 4:  F Ship: docs, full e2e, security review, deploy, live verify ◀┘
```

Each phase runs on its own branch (`one-app/<letter>-<name>`) in its own
worktree. At the boundary:
1. The phase's definition of done is met.
2. An independent reviewer checks the diff against the spec. Correctness and
   security findings are fixed in one wave.
3. The controller re-runs the suites and merges into `master` with a
   fast-forward or a rebase, never a merge commit.

---

## Phase A — Gate (front door)

**Outcome:** Every request passes through the gate. There is a real login
page, sessions, optional TOTP, rate limits in every mode, CSRF protection,
device tokens, and credential stripping. code-server moves to `/vscode/`, and
Caddy no longer authenticates.

**Deliver:**
- `web/gate` workspace package, plus `images/gate/Dockerfile` (multi-stage,
  non-root, read-only root filesystem friendly).
- The `gate` service in `docker-compose.yml` (volume `agentbox_gate`, caps,
  healthcheck).
- `proxy/Caddyfile.standalone` and `proxy/Caddyfile.behind-proxy` reduced to
  TLS, compression and `reverse_proxy gate:7900`, keeping WebSocket and
  streaming behaviour. The traefik overlay keeps its outer rate limit.
- **Store.** A JSON file in `/data` with atomic writes (temp + rename, fsync),
  schema-versioned. It holds the password hash (seeded from
  `AGENTBOX_PASSWORD_HASH` when absent), sessions, TOTP (secret, recovery-code
  hashes), device codes, tokens, and an empty `apps` collection for Phase C.
- **Routing.** The spec's table on the raw URI with the raw-path guard (port or
  share `web/bridge/src/path-guard.ts`).
  - WebSocket proxying.
  - Stripping of `__Host-agentbox`, `__Secure-agentbox-app` and
    `Authorization` from everything forwarded.
  - `/vscode/*` → code:8080 with the prefix stripped.
  - ttyd paths unchanged.
  - The catch-all → bridge :7800.
  - A navigation without auth → `302 /login?next=`; otherwise `401`.
- **Login.**
  - `/login` page, a small static page styled with the app's tokens.
  - `POST /_gate/login {username, password, remember, code?}`.
  - `POST /_gate/logout`.
  - `GET /_gate/session`.
  - `GET /_gate/sessions`, `DELETE /_gate/sessions/:id`,
    `DELETE /_gate/sessions?others=1`.
  - `POST /_gate/password {current, next}`.
- **TOTP.**
  - `POST /_gate/totp/setup` → `{secret, otpauthUrl, qrSvg}`.
  - `POST /_gate/totp/confirm {code}` → `{recoveryCodes}`.
  - `DELETE /_gate/totp {password}`.
  - Login accepts a TOTP code or a recovery code.
- **Device flow and tokens.**
  - `POST /_gate/device/start {name}`.
  - `POST /_gate/device/poll {deviceCode}`.
  - `GET /_gate/device/pending?code=`, owner only.
  - `POST /_gate/device/approve {userCode}` and `POST /_gate/device/deny {userCode}`, owner only.
  - `GET /_gate/tokens` and `DELETE /_gate/tokens/:id`.
  - `abx_` bearer tokens stored hashed.
  - A minimal approval page at `/settings/devices?code=`, served by the gate
    until Phase D's Settings screen takes that route over.
- **Rate limits.**
  - Rate limits and lockout exactly as the spec states, applied before bcrypt.
  - Client-IP trust only for connections from the proxy
    (`AGENTBOX_CLIENT_IP_HEADER`).
- **CSRF.** Origin / `Sec-Fetch-Site` enforcement on non-GET requests to
  authenticated routes. Bearer requests are exempt.
- `GET /_gate/version` returns `{version}`.
- `/cli/*` static route returning 404 until Phase E provides files.
- **Admin commands.** A `agentbox-gate` command inside the image, with
  `set-password`, `totp-reset` and `revoke-all`. `scripts/agentbox` gains
  `passwd` and `totp reset` wrapping it via `docker compose exec`.
  `install.sh --password` sets the store through the same command once the
  stack is up.
- Installer minors folded in:
  - `ExecStop=-…` in the egress unit.
  - The isolate-host self-check probes a host port that is really listening,
    or says plainly what it did not prove.
  - Never write `https://localhost` as the public URL.
- `tests/proxy/share-bypass.sh` becomes `tests/proxy/gate-bypass.sh`. It runs
  real Caddy + the gate + echo upstreams standing in for every sandbox port,
  and proves:
  - no unauthenticated path trick reaches any upstream;
  - our cookies and `Authorization` never arrive upstream;
  - lockout works.
- The e2e harness (`web/app/e2e/start-stack.mjs`) runs the gate in front of
  the bridge. The Playwright tests log in first. A login spec covers bad
  password, lockout message, TOTP login and logout.

**Consumes:** nothing new. **Produces** for later phases:
- the gate package layout;
- `store` accessors (`store.apps` for C);
- `authenticate(req) → {kind: "session"|"token", id} | null`;
- a `proxyTo(upstream, opts)` helper with the stripping built in;
- the route table where C adds `/a/*` and `/_gate/tunnel` and E adds `/cli/*`.

**Pitfalls:**
- `__Host-` cookies need `Secure` and `Path=/`. Browsers accept `Secure`
  cookies on `http://localhost`, so local dev works.
- The traefik overlay must keep publishing no ports.
- Caddy must forward `X-Forwarded-For` / `-Proto` / `-Host`, and pass the
  original Host through.
- The login page must work with JavaScript disabled only as far as a plain
  form post; no need for more.

**Done when:**
- Every unit test passes.
- `gate-bypass.sh` passes.
- e2e passes through the gate.
- `docker compose -f docker-compose.yml -f docker-compose.standalone.yml config`
  and the traefik variant validate, and Caddy validates.
- A local `docker compose up` shows the login page. After login, `/vscode/`
  and `/workbench/` work, including terminals and websockets.
- `docs/install.md` and `docs/security.md` describe the new login, TOTP,
  devices and the two rules.

---

## Phase B — Bridge backend, and the app at `/`

**Outcome:** The bridge serves the app and its API from the root, and it
offers the backends the new surfaces need: files, WebDAV, system, projects,
and the editor channel with its VS Code extension.

**Deliver:**
- **Root move.** SPA at `/` with history-API routing: the bridge serves
  `index.html` for GET navigations outside `/api`, `/ws` and static assets.
  - The API moves to `/api/*` and sockets to `/ws/*`.
  - `web/app/src/api/base.ts` no longer derives the base from the first path
    segment.
  - `/workbench*` is permanently redirected to `/workbench`, the new route of
    the Workbench surface.
  - `WORKBENCH_BASE_PATH` is removed. `agentbox-review`'s default URL becomes
    `http://127.0.0.1:7800`, and its printed link becomes
    `<public>/workbench?review=<key>`.
  - Existing e2e tests are updated to the new paths.
- **Files API.** Exactly the spec's table, in `web/bridge/src/files/`:
  - confinement with `realpath`;
  - chunked uploads with a 50 MiB chunk cap, temp files in
    `/workspace/.agentbox/uploads`, and cleanup of abandoned uploads after 24 h;
  - streamed zip;
  - trash with restore metadata;
  - git status via `git status --porcelain=v2 -z`, cached for 2 s per repo;
  - name search via `fdfind`/`fd`, the Debian binary name included;
  - raw serving with `Content-Security-Policy: sandbox` and `nosniff`.
- **WebDAV** at `/api/dav/*` over the same root, enough for macOS Finder,
  `gio mount` and `rclone` to read and write (locks as Finder needs them).
- **System.** `GET /api/system` → `SystemInfo`:
  - cgroup v2 CPU usage and limit, memory used and limit, PIDs;
  - statfs for `/workspace` and `/home/coder`;
  - uptime;
  - the top 15 processes;
  - versions of agentbox, herdr, code-server and each agent CLI found on
    `PATH`.
- **Projects.**
  - `GET /api/projects` → `Project[]`: top-level directories of the workspace
    root, with git info, the herdr panes whose cwd is inside, and the listeners
    whose process cwd is inside.
  - `POST /api/projects/clone {url, name?}` runs `git clone`, progress on the
    events socket as `project.clone`.
  - `POST /api/projects {name}` makes an empty folder.
- **Editor channel.**
  - `/ws/editor`, a localhost-only socket that the extension connects to.
  - `POST /api/editor/open {path, line?}` → `{delivered}`.
  - `web/vscode-ext`: the `agentbox-connect` extension, built to a VSIX and
    installed in the workspace image. It opens files at a line and reports
    readiness.
- Shared types in `web/shared`: `FileEntry`, `TrashItem`, `UploadSession`,
  `SystemInfo`, `Project`.

**Consumes:** nothing from A (it can run beside it).

**Produces:** the endpoints above with the shared types, for D and E, and the
root paths every later phase uses.

**Pitfalls:**
- Every mutating route must be safe when called twice (a retried upload
  chunk, a double-clicked trash).
- Symlink loops.
- Filenames with newlines and non-UTF-8 bytes.
- `EXDEV` if trash ever crosses volumes; keep it on the workspace volume.
- Large directories: paginate or cap at 5000 entries with a flag.

**Done when:**
- Unit tests cover confinement (symlink escape, `..`, absolute paths), a
  chunked upload with retry, zip, trash/restore, DAV (a litmus-style
  read/write/copy/move/lock run with an actual WebDAV client, e.g. `rclone`
  or a `webdav` client library), system parsing against fixture cgroup files,
  and projects.
- The existing e2e tests pass at `/`.
- The image builds with the extension, and code-server lists it as installed.

---

## Phase C — Apps and agents

**Outcome:**
- The spec's app model is live: `/a/<id>/`, visibility and sharing, and the
  path-fidelity layer.
- A plain `npm run dev` Vite React app and an `agentbox-preview start` app
  both work in the dock with HMR, private and shared, in all three browser
  engines.
- Agents are told how the box works, and use the preview.

**Deliver:**
- **Gate.**
  - App registry (`store.apps`) and the sandbox-side API on :7901.
  - `/a/<id>/` admission: grant cookie, session/token, link, passcode page,
    font exemption, 404/login uniformity.
  - The full app policy: CSP sandbox, stripping, `Set-Cookie` rewrite, CORS
    for `Origin: null` and preflights, WebSockets, `Location` rewrite.
  - The fidelity layer: HTML rewrite, import map, `shim.js`, CSS `url()`, and
    the hint signal as response header `X-Agentbox-Hint: root-absolute` for
    the dock to read via its probe.
  - Owner visibility API `/_gate/apps`, `/_gate/apps/:id/visibility`.
  - Revocation and expiry cut-off, with a 30 s sweep.
  - `/_gate/tunnel?target=tcp:<port>|herdr`, bearer only.
- **Bridge.**
  - Data-plane listener :7801 serving `/app/<port>/…`: Host/Origin/Referer
    normalisation, the existing fallback page, and back-pressure.
  - `/tunnel/tcp/<port>` and `/tunnel/herdr` on the same listener.
  - `/api/apps*` merging registry and liveness (listening, pid, cwd, owning
    pane).
  - `POST /api/apps/:id/open` emits `app.open`; `/restart` and `/stop`.
  - Events `app.open` and `apps.changed`.
  - Pinned-app relaunch in an **Apps** herdr workspace on start.
- **Removals.**
  - `/workbench/preview`, `/s/` and the share store.
  - Hostname previews: `docker-compose.previews.yml`, `Caddyfile.previews`,
    `--preview-domain`, and the preview-domain code paths.
  - `--preview` becomes an alias of the new `--sharing on|off`.
- **App (PreviewPanel only; Phase D owns everything around it).**
  - `PreviewPanel.tsx` moves to the app model: picker of apps plus "also
    listening" ports, a path bar, reload, full screen, device widths, the
    Share popover (mode, expiry, passcode, copy link, stop sharing), the hint
    line, and "Open on your machine".
  - The store gains `ui.previewAppId` and an `openApp(appId: string)` action,
    which opens the right-hand panel on Preview with that app.
  - `app.open` events call `openApp` and toast "<by> opened <name> in Preview".
- **Agents.**
  - The managed `CLAUDE.md`, at the verified Linux path, baked into the image.
  - The Codex `AGENTS.md` managed block written by the entrypoint.
  - `images/workspace/skills/preview/SKILL.md`, and the `review` skill
    updated.
  - `images/workspace/agentbox-preview`: dependency-free Node, with the
    commands and exit codes the spec gives, Vite detection, `static <dir>`,
    and the calling agent's workspace detected from herdr's pane environment
    when available.
  - `welcome.md` updated.
- **Tests.**
  - The fidelity suite as the spec's Testing section states it, as a Playwright
    project over a fixture `create-vite` React-TS app. Dependencies are
    installed once and cached; document the command.
  - `gate-bypass.sh` extended to `/a/`: a private app is unreachable logged
    out; the data plane is unreachable through the proxy; infrastructure ports
    are refused as apps; a tunnel without a bearer token is refused.

**Consumes:**
- A's store, `authenticate`, `proxyTo` and route table.
- B's root paths and the `/api` prefix.

**Produces:**
- `AppView` in `web/shared`, and the events and the `openApp` action for D.
- The tunnel protocol for E: a WebSocket with binary frames carrying raw bytes
  in both directions. Text frames are control frames:
  `{"type":"error","message"}`, then close.

**Pitfalls:**
- An opaque-origin document's module scripts are CORS without credentials
  unless `crossorigin="use-credentials"`.
- `document.cookie` and `localStorage` *throw* in opaque origins.
- Import maps must precede the first module script.
- Request HTML with identity encoding only when rewriting; stream everything
  else untouched.
- Never buffer an unbounded response.
- Vite 6 checks the WebSocket `Origin`; normalise it.
- Keep the fallback page navigation-only and before the first byte.

**Done when:**
- The fidelity suite is green in Chromium, Firefox and WebKit. Document any
  engine-specific gap the spec anticipates, with its test marked as expected.
- Unit tests and the extended bypass suite pass.
- A manual run of J2 in the local stack works end to end.
- `docs/workbench.md` (apps and sharing) and `docs/security.md` (the app
  policy) are rewritten.

---

## Phase D — The one app

**Outcome:** The shell the spec describes, at `/`. It has:
- the rail (or bottom bar) with Home, Workbench, Editor, Files, Apps and
  System;
- Settings;
- the global dock;
- the ⌘K palette over everything;
- surfaces that stay mounted;
- deep links;
- a mobile layout.

It looks and moves like the rest of the rubl-derived app.

**Deliver:**
- A shell frame with client-side routing: the spec's routes, deep links that
  survive a reload, back and forward.
- Surfaces:
  - **Home**: needs-you, projects (with new project and clone), apps, the
    system strip.
  - **Workbench**: the existing client, minus its brand header and the
    inspector.
  - **Editor**: the kept-alive iframe of `/vscode/`, "Open in editor" via
    `/api/editor/open`, and shortcut handling across the iframe.
  - **Files**: tree, list, upload, download, trash, quick look, actions.
  - **Apps**: the list, the actions, and "also listening".
  - **System**: stats plus the detailed btop view.
  - **Settings**: account (password, TOTP with QR code, sessions), devices
    and CLI (tokens, the pending approval flow on `/settings/devices?code=`,
    which takes that route over from the gate's stub, and the install line),
    sharing, appearance, about.
- A global dock hosting `PreviewPanel` and `ReviewPanel` without changing
  their internals. It is driven by `ui.inspector` and `openApp`.
- A palette with a group per kind, backed by `/api/files/search`,
  `/api/projects`, `/api/apps`, the session store and actions.
- A mobile layout at ≤ 700 px, with a bottom bar and a "More" sheet.
- Keyboard shortcuts that avoid browser-reserved and VS Code default bindings.
  Document them in the keymap sheet.

**Consumes:**
- A's `/_gate/*` APIs.
- B's files, system, projects and editor endpoints.
- C's `AppView`, events, `openApp` and PreviewPanel.

Start from master after A and B. Build against C's contracts. Rebase onto C
once it merges, before calling the phase done.

**Produces:** the shell for F to verify.

**Pitfalls:**
- Hidden surfaces must not keep expensive work running. Pause polling in
  hidden surfaces, but keep sockets open.
- The editor iframe must never be recreated by a React re-render.
- The focus trap and Escape handling in the dock and dialogs.
- Drag-and-drop of folders (`webkitGetAsEntry`) with progress and cancel.

**Done when:**
- Unit tests pass for routing, the palette and the surfaces' logic.
- Playwright e2e covers J1, J4, J5 and J7 (mobile viewport) against the full
  local stack through the gate, including the kept-alive editor (typing in it,
  switching away and back, and the text is still there).
- Screenshots of every surface in light and dark land in `docs/images/`.
- `README.md` and `docs/workbench.md` describe the app.

---

## Phase E — Local CLI

**Outcome:** `agentbox` on a laptop reaches everything in the box, exactly as
the spec's CLI section describes, and installs from the box itself.

**Deliver:**
- `web/cli`, bundled with esbuild into `dist/agentbox.mjs` (one file with a
  Node shebang; `ws` bundled).
- Every command in the spec's table, with `--json`.
- The device-flow login. It opens the browser, and falls back to printing the
  URL.
- The ttyd client protocol for `attach` and `shell`: raw mode, resize, the
  `Ctrl-]` `q` detach.
- TCP forwarding and the herdr socket over the tunnel protocol, with 25 s
  keepalive.
- Chunked uploads and downloads with progress.
- `mount`: a local WebDAV front with a random path secret, plus the OS mount
  commands per platform.
- `update`, and version-mismatch warnings.
- `install.sh` ends by printing the CLI install line for this box.
- The gate serves `/cli/install` (a POSIX `sh` script) and `/cli/agentbox.mjs`.
  The gate image copies the CLI bundle in.

**Consumes:**
- A: device flow, tokens, `/cli/*`.
- B: files, DAV, system, projects.
- C: apps, tunnels.

**Produces:** the CLI and `docs/cli.md`.

**Pitfalls:**
- Windows has no Unix sockets for `herdr socket`. Say so and skip it.
- `mount` must fail with a clear message when the OS helper is missing.
- Never write the token anywhere but the 0600 config.
- Restore the terminal state on every exit path, including errors and
  signals.

**Done when:**
- Unit tests pass.
- A CLI e2e script runs against the local stack. It logs in through the
  device flow, approving through Playwright or the API with a session. It then
  runs `status`, `attach` (and sees herdr's UI in the stream), `forward` (and
  curls through it), the `files` round trip, `mount --no-mount` against a
  WebDAV client, and `apps share`/`unshare`.
- `curl …/cli/install | sh` works in a clean container with Node 22.

---

## Phase F — Ship

**Outcome:** The whole thing is documented, verified end to end, reviewed for
security as one system, deployed to the live box, and verified there in a
real browser and from a laptop.

**Deliver:**
- A fresh-eyes security review of the full diff against the spec's two rules
  and app policy, done by an independent reviewer. Fix everything Critical and
  Important.
- A bug hunt: a Playwright pass through J1–J7 on the full stack, and a
  checklist of edge cases (reconnects, a restart mid-upload, an expired share
  while viewing, a lost session while in the editor). Fix what breaks.
- A docs overhaul so a new operator can install, log in, enable TOTP, install
  the CLI and share an app from the docs alone.
- The deploy, per the private runbook: images built locally and shipped; a
  backup; the gate seeded from the current hash; switching the proxy; rollback
  ready. Then live verification of the journeys, and the CLI from the
  developer's laptop against the box. Other stacks on the host stay untouched.

**Done when:**
- Every suite is green.
- The live checklist passes.
- The operator can use every journey.
