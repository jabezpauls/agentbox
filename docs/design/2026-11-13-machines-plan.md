# Machines — implementation plan

> **For agentic workers:** this plan is executed **one agent per phase**, not
> task by task. Each phase lists its outcome, what it must deliver, the
> interfaces it produces and consumes, and a definition of done. Plan your own
> steps inside the phase, test-first (vitest, Playwright, shell tests), and
> commit as you go in small, reviewable commits. Read the spec first; this plan
> argues from it. Where this plan and the spec disagree, the spec wins — say so
> in your report.

**Goal:** Let the owner join their own Linux and Windows computers to agentbox
and run Claude Code on them from the browser, without letting anything the
sandbox controls reach those computers.

**Architecture:** The gate learns hostnames and serves a second, gate-only
origin for machines. A node (a mode of the CLI, also built as a standalone
executable) holds one outbound WebSocket to the gate, runs a local herdr, and
serves the bridge's own API over that link from code shared with the bridge.
The machine itself checks the owner's presence (a passphrase-derived
challenge) before opening terminals, agents or files.

**Tech stack:** Node 22 (server), Node ≥ 20 / single-executable application
(node), TypeScript, Fastify 5, `ws`, React 19, Vite, xterm.js, vitest,
Playwright, Caddy 2, Traefik, Docker Compose, systemd user units, Windows Run
key, herdr 0.9.3, Claude Code ≥ 2.1.225.

**Spec:** `docs/design/2026-11-13-machines-design.md`.

## Global constraints

- **One-way trust.** No new path from any sandbox service to a machine. No
  main-origin credential (session, person token, password, TOTP) opens the
  machines origin on its own.
- **Dark until enabled.** Every phase merges to `main` and is released with
  the feature **off**: without `AGENTBOX_MACHINES_HOST` and
  `AGENTBOX_MACHINE_APPS_HOST` set, every machines route answers `404` and
  nothing in the box changes. A release must never change an existing box's
  behaviour.
- **On a machine:** no root/admin, no WSL, no Node.js requirement (from phase
  6), no Docker requirement, no keyring, no native add-ons, no listening
  network port. Unix socket / named pipe only; owner-only, or (a Windows pipe,
  whose ACL Node cannot set) every request carrying a secret from an owner-only
  file.
- **No new runtime dependencies** in the gate beyond moving `ws` from
  devDependencies to dependencies. The node bundles only what the CLI bundles
  today plus code from the new shared package.
- **Never touch the sandbox's compose services** (`code`, `terminal`, `shell`,
  `ssh`, `monitor`, `workbench`) except to add the Workbench link. Deploying any
  phase must not restart the sandbox.
- **Secrets** never in argv, logs, `gate.json`, URLs, or test fixtures that
  look real. Passphrases and passwords reach CLIs on stdin only.
- **Commits and PRs carry no AI/Claude attribution** (no `Co-Authored-By`
  trailer, no "Generated with" line). The repository is public.
- Node ≥ 22 for server packages; the CLI and node run on Node ≥ 20 (the
  `.mjs`) or standalone.
- Codex is out of scope on machines.

## Workflow

```
feat/machines ── spec + this plan (merged first, docs only)
   │
   ├─ machines/p0-spike        (throwaway; findings doc only is merged)
   ├─ machines/p1-gate-hosts   ─┐
   ├─ machines/p2-shared-code  ─┤ independent: may run in parallel
   ├─ machines/p3-link-join    (needs p1, p2)
   ├─ machines/p4-agents       (needs p3)
   ├─ machines/p5-files-preview(needs p4)
   ├─ machines/p6-standalone   (needs p3; may run beside p4/p5)
   ├─ machines/p7-windows      (needs p5, p6)
   └─ machines/p8-ship         (needs all)
```

For every phase:

1. **Brief.** The orchestrator (the main session) writes the phase brief: this
   plan's phase section, the spec path, the findings of earlier phases, and
   anything the owner decided since.
2. **Build.** One implementer agent per phase, in its own git worktree, on its
   own branch from the latest `main`. It plans its own steps, works
   test-first, commits as it goes, pushes, and opens a PR to `main` whose body
   lists what was built, how it was verified, and anything it deferred.
3. **Review.** A fresh reviewer agent that did not build it reviews the PR
   against the spec and this phase's definition of done — security phases
   (1, 3, 4, 5, 6) with an explicit attack brief. Findings go back to the
   implementer (same agent, resumed) until none of blocker or major severity
   remain.
4. **Verify.** The orchestrator runs the phase's acceptance checks itself,
   reads the diff's security-relevant parts, and confirms CI is green.
5. **Merge.** Squash-merge to `main` when 3 and 4 pass. Merging releases; the
   feature stays dark.
6. **Report.** A short note to the owner: what landed, what it proved, what
   moved.

Deploying to the owner's box happens only in phase 8, after asking — or
earlier only if the owner asks. Each deploy is checked first for whether it
restarts the sandbox; if it would, it waits for the owner.

---

## Phase 0 — Spike (throwaway)

**Outcome:** the six unknowns answered with evidence, and the spec amended.

**Deliver** `docs/design/2026-11-13-machines-spike.md` (merged) with, for each
question, what was tried, the result, and the spec change. Scratch code stays
out of the repository.

1. herdr 0.9.3 on Windows: install from `herdr-windows-x86_64.zip`; reach its
   control named pipe from Node `net.connect` with NDJSON; run `terminal
   session control` over stdio and stream a pane. Record pipe naming, and
   digests for the zip to pin.
2. Claude Code ≥ 2.1.225 in a herdr pane, headless: with
   `CLAUDE_CONFIG_DIR=<dir>` seeded `{"hasCompletedOnboarding": true}`,
   `CLAUDE_CODE_OAUTH_TOKEN` set, `DISABLE_UPDATES=1`, and
   `--append-system-prompt-file`: does it start signed in with no prompt, on
   Linux and Windows? Use a throwaway `setup-token` and revoke it after.
   **Never let a test open the owner's browser** (set `BROWSER=true` /
   unset display variables; run in a container or VM).
3. Revocation: revoke that token at claude.ai; how long until a running and a
   new session fail?
4. Single-executable: the node bundled as CommonJS into a SEA on Node 22 and
   24 — size per platform; startup time; that `ws`, `node:crypto` PBKDF2 and
   `net` named pipes work inside it.
5. Hidden start on Windows: a GUI-subsystem stub (`windowsHide` spawn of the
   SEA) launched from `HKCU\…\Run` — no window at logon, and none from
   children.
6. Smart App Control on Windows 11 (evaluation and on): does it block the
   unsigned SEA and herdr? Cost and route for Authenticode signing.

**Done when:** every question has an answer with evidence; the spec reflects
them; the owner has been told of any decision needed (signing).

---

## Phase 1 — The gate learns hostnames; the machines origin exists

**Outcome:** with the two hostnames configured, the machines origin serves a
sign-in and an empty Machines page with every rule from the spec's "The
machines origin's rules" and "The machines session" — and the security suites
prove it. No node yet.

**Deliver:**

- `web/gate/src/hosts.ts` — `classifyHost(req): "main" | "machines" |
  "machine-apps"`, `421` otherwise; config `machinesHost`, `machineAppsHost`
  (`web/gate/src/config.ts`), both or neither.
- Route tagging in `web/gate/src/app.ts` / `routes.ts`: every route declares
  its hosts; untagged serves nothing; existing routes tagged `main`. A test
  enumerates every registered route and fails on an untagged one.
- Audiences on sessions in `web/gate/src/auth.ts` / `store.ts`
  (`aud: "main" | "machines"`); the machines origin accepts only
  `aud: "machines"` cookies and no bearer tokens.
- `web/gate/src/machines/` — `passphrase.ts` (bcrypt cost 14, set via a gate
  CLI command reading stdin), `handoff.ts` (nonce store: random, single use,
  60 s, bound to the main session), `session.ts` (12 h / 30 min idle; ended by
  sign-out, password change, passphrase change, `revoke-all`, disable),
  `headers.ts` (the response header set and the same-origin/`Origin` rules),
  `pages.ts` (sign-in and a static Machines shell; unframable).
- `/login` may return to exactly `/_gate/machines/handoff`.
- `scripts/agentbox machines enable|disable` (host only; passphrase on the
  terminal, piped on stdin to `docker exec -i <gate> agentbox-gate
  machines-passphrase`); installer flags `--machines-host`, `--apps-host`
  carried in `.env`.
- Proxy wiring for both hostnames in `proxy/Caddyfile.standalone`,
  `Caddyfile.behind-proxy`, `Caddyfile.passthrough`, and the Traefik overlays
  (`docker-compose.traefik*.yml`), only when set.
- Tests: unit tests for each module; `tests/proxy/gate-bypass.sh` and
  `tests/proxy/topology.py` extended per the spec's Testing table (machines
  origin rows); `tests/install/` coverage that `.env` keeps the hostnames and
  that a box without them is unchanged.

**Produces:** `classifyHost`, the route-tag API (`hosts: ["machines"]` on route
options), `requireMachinesSession(req): MachinesSession` (with `id`), the
machines header helpers, the empty machines UI mount point at `/`.

**Done when:** all of the above tests pass in CI; a box without the hostnames
behaves byte-for-byte as before (gate-bypass suite unchanged rows pass);
reviewer finds no way to get a machines session without the passphrase, or to
use one from the main origin or the sandbox.

---

## Phase 2 — Shared code (no behaviour change)

**Outcome:** herdr and file-service code live in one package both the bridge
and the node import, and the app's API calls go through a base URL. The box
works exactly as before.

**Deliver:**

- New workspace `web/hostcore` (package `@workbench/hostcore`, listed in
  `web/package.json` workspaces) holding, moved from `web/bridge/src/`:
  `herdr/socket.ts`, `herdr/terminal.ts`, `herdr/session.ts`,
  `rpc-allowlist.ts`, `path-guard.ts`, and `files/*`. The bridge imports them;
  no copies.
- The file service generalised from two fixed roots to
  `roots: { id, path, mode: "read" | "write", stateDir }[]`, with an optional
  case-insensitive comparison and an injectable "hidden" and "write-denied"
  predicate (the bridge passes none, keeping today's behaviour).
- `web/app/src/api/client.ts` and every hardcoded `/api`, `/ws`, `/_gate/apps`,
  `/a/` in `web/app/src` go through one `apiBase` (default `""`), so a second
  build entry can point them at `/m/<id>`.
- No dependency on Node-only APIs that a single-executable cannot carry (no
  native add-ons; check `files/zip.ts`, `files/search.ts` for spawned tools and
  note which need ripgrep — the node must tolerate their absence).

**Produces:** the package's exports (`herdrRequest`, `subscribe`,
`attachTerminal`, `FileService` with the roots config, `isRpcAllowed`,
`guardPath`), and `setApiBase(base: string)` in the app.

**Done when:** `npm test`, `npm run typecheck`, `npm run lint`, the app e2e and
the fidelity suite pass unchanged; the diff is moves and the two
generalisations only.

---

## Phase 3 — Link, registry, join, service (Linux)

**Outcome:** `agentbox node join` on a Linux machine (Node 20+ `.mjs` for now)
pairs it through the machines origin, enrols presence, starts a systemd user
service, and the machine shows online with its specs. No streams yet.

**Deliver:**

- Gate: `web/gate/src/machines/link.ts` (`/_gate/node`, main host, `viaProxy`
  only, node token only; framing, hello, heartbeat, `ok|upgrade|duplicate|
  revoked`, limits), `registry.ts` (store records: id, name, platform, specs,
  version, policy summary, last seen, opt-ins; in-memory connected set),
  `joins.ts` (machine-join record kind; typed code; IP observed; 10 min; 3
  pending; approve on the machines origin; name suffixing; re-join in place
  only with proof of the old node token), `audit.ts` (own append-only file,
  rotated; join/revoke/token events never rotated out), Admin page sections
  for pending joins, machines, revoke, audit.
- Node: `web/cli/src/node/` — `join.ts` (steps 1–7 of the spec's Joining, in
  order; install-and-verify before the token; refuse a second box), `link.ts`
  (client, backoff, wake detection, `revoked` only via control message),
  `policy.ts` (read, validate, deny-on-broken, watch), `credentials.ts`,
  `presence.ts` (PBKDF2 enrol only, this phase), `service-linux.ts` (user unit,
  linger and its fallback), `control.ts` (Unix socket), commands `node join|
  run|status|pause|resume|leave|logs|passphrase` in `web/cli/src/commands/`.
- Shared framing codec in `@workbench/hostcore` (used by gate and node).
- `machines disable` (phase 1) now also closes every link, and the registry
  refuses links while disabled.
- Tests: unit for framing, limits, duplicate rule, revoke semantics, join
  ordering and rollback, policy parsing; an integration test in the gate's
  suite with an in-process node; the CI e2e "machine" container joining a
  stack (extending `web/cli/e2e/` or a new `tests/machines/`).

**Consumes:** phase 1's host routing and `requireMachinesSession`; phase 2's
package.

**Produces:** `openStream(machineId, kind): Promise<Duplex>` on the gate side
(stubbed to refuse until phase 4), `NodeLink` events on the node side, the
registry API used by the UI.

**Done when:** in CI, a container joins, shows online with specs, survives a
gate restart, goes offline when paused and on network loss, is refused as a
duplicate, and stops on revoke without deleting anything but `secrets/`;
reviewer finds no way for a node token to do anything but hold its link, and
no way to slip a machine into the list without the typed code.

---

## Phase 4 — Agents and terminals, with presence

**Outcome:** from the machines origin, the owner proves presence, sees the
machine's herdr workspaces and agents, opens terminals, and starts Claude Code
there signed in with the shared token.

**Deliver:**

- Streams over the link (gate dialer reusing `proxyHttp`/`proxyUpgrade`;
  per-stream window; 64 MiB gate budget with 30 s queue; 256 per link).
- Node HTTP server (non-listening, fed by streams) serving herdr RPC (through
  the allowlist) and the terminal WebSocket from the shared package; response
  headers rebuilt by the gate per the spec ("Responses from a machine").
- Presence: node challenge/grant (`presence.ts` completed), browser side in the
  machines UI (WebCrypto PBKDF2 + HMAC), grant on every stream, lockout.
- Policy enforcement for `terminals` (and policy tightening closing streams).
- herdr: install (pinned), supervise, socket health check, headless attach
  after restore, idle-only update hook.
- Claude Code: pinned direct download and verify; `CLAUDE_CONFIG_DIR` seeded;
  `claude` shim reading `secrets/claude-token`; `DISABLE_UPDATES=1`;
  `--append-system-prompt-file` with `images/machine/agents.md` (new);
  shared token on the Admin page (gate write-only secrets file; per-machine
  opt-in; wipe on revoke; "agents on the old token" list).
- Machines UI: a second Vite entry in `web/app` using `setApiBase("/m/<id>")`,
  built into the gate image (`web/gate/scripts/copy-assets.mjs`, the gate
  Dockerfile); Machines list and a machine's agents/terminals view.
- Workbench: a "Machines" link (new tab, `noopener noreferrer`) shown only when
  the box reports machines enabled.

**Done when:** CI e2e: presence → terminal runs a command → a workspace with a
stub agent appears live → tighten `terminals: false` mid-session closes it →
wrong passphrase five times locks; gate-bypass rows for machine responses
(HTML body → 502, `Set-Cookie` dropped) pass; reviewer cannot open a terminal
without a live grant, including as a compromised gate holding a machines
session.

---

## Phase 5 — Files and Preview

**Outcome:** the owner browses and edits allowed folders on a machine, and sees
an agent's app on the machine-apps origin.

**Deliver:**

- Files over the node's HTTP server using the shared `FileService` with the
  policy's roots and modes, the write-deny and hidden lists on real paths, the
  Windows path refusals (implemented now, exercised in phase 7), trash in
  `state/trash/` (7 days).
- `agentbox-preview` on a machine (control socket → node → gate's machine-apps
  registry, separate from the box's); app streams on the machine-apps host
  under the box's app policy; `127.0.0.1` then `[::1]`, no redirects;
  registration expiry; 64 apps per machine; `share` honoured as the spec says.
- Machines UI: Files and Preview for a machine.
- Fidelity suite: the machine-apps rows.

**Done when:** CI e2e: read/write in an allowed folder, refused write to
`~/.bashrc` and to the node folder, hidden `~/.ssh`, symlink escape refused;
`agentbox-preview` app loads in an opaque origin and cannot read the machines
origin; reviewer finds no write path to code execution with `terminals: false`.

---

## Phase 6 — Standalone executables and signed updates

**Outcome:** a machine needs no Node: one download, one command; updates come
only from signed GitHub releases.

**Deliver:**

- `web/cli/scripts/build-sea.mjs`: CommonJS bundle → SEA for linux-x64,
  linux-arm64, win-x64 (per phase 0's findings); release job in
  `.github/workflows/release.yml` attaching them.
- Signed manifest: CI job signs `machines-manifest.json` (node, herdr, Claude
  Code URLs + SHA-256 per platform) with an ed25519 key from a repository
  secret; two public keys built in; `RELEASING.md` documents rotation.
- Node updater: fetch from GitHub Releases, verify, refuse not-newer,
  `updates: auto|notify|off`, herdr idle-only; box-served CLI update disabled
  where a node is installed.
- Install path: `https://github.com/jabezpauls/agentbox/releases/latest` asset
  plus a one-liner per platform in `docs/machines.md` (draft).

**Done when:** a tampered binary, an unsigned manifest, a manifest signed by an
unknown key, and an older signed version are each refused in tests; the CI e2e
"machine" container runs the SEA, not the `.mjs`.

---

## Phase 7 — Windows

**Outcome:** the same flows on Windows 11, no admin, no WSL.

**Deliver:**

- herdr from the zip (pinned digests), named-pipe control, `terminal session
  control` streaming (phase 0: all work as on Linux; no ConPTY fallback
  needed).
- `service-windows.ts`: Run entry + `agentbox-node.exe node supervise` (the
  SEA with its PE subsystem set to GUI, built in CI); `windowsHide` on every spawn;
  log rotation; `leave` removes the entry.
- Shell default (`pwsh` else Windows PowerShell); paths; the Windows hidden and
  write-deny lists; UNC/device/stream/trailing-dot refusals exercised.
- Smart App Control: what the owner decided after phase 0 (signing, or
  documented as unsupported).
- CI: a `windows-latest` job running the node against a protocol stub of the
  gate's link: join, pipe, terminal, Files path rules, Run entry add/remove.

**Done when:** the Windows job is green, and the owner's Windows machine joins
and runs Claude Code from the browser (by hand, with the owner).

---

## Phase 8 — Hardening, docs, ship

**Outcome:** documented, independently reviewed end to end, and running on the
owner's box.

**Deliver:**

- `docs/machines.md` (setup per platform, DNS records, the passphrase rule
  "type it only where the address bar reads the machines host", limits of a
  setup token, what a compromised box can and cannot do), a `docs/security.md`
  section, `README.md` and `docs/install.md` updates, `.env.example`.
- A whole-feature security review by a fresh agent against the spec's threats
  1–4, with fixes.
- Deploy: the owner adds DNS records for `machines.jabezpaul.tech` and
  `mapps.jabezpaul.tech`; the orchestrator checks the deploy restarts only the
  gate and proxy (not the sandbox), asks, then runs `machines enable` with the
  owner typing the passphrase, and joins the owner's Linux laptop.

**Done when:** the owner opens the machines tab from the Workbench, proves
presence, and runs Claude Code on their laptop and Windows machine from the
browser.
