# Machines: your own computers, joined to agentbox

Status: design v2, November 2026. v1 was reviewed independently (findings
folded in below); the owner decided the open questions. Covers "B" — agents
working on a joined machine. "A" — sending compute jobs to a machine — is kept
in view so nothing here blocks it, but is not built.

## Why

agentbox today is one box: a sandbox on a VPS, reached from a browser or the
`agentbox` CLI. The owner has other computers — a laptop, a home server, a GPU
rig, a Windows PC — and wants them in the same system:

- open a machine from the browser and work there: run Claude Code **on that
  machine**, in its folders, with its Docker, its `npm`, its ports;
- see an app an agent starts there in a Preview, as on the box;
- browse and edit that machine's files from the browser;
- and, the other way, use the box from the machine (this exists: `agentbox
  attach`, `shell`, `files`, `mount`, `forward`).

One sign-in for Claude Code across every machine, and nothing heavy to install.

## Principles

Requirements; every later section is checked against them.

1. **Trust goes one way.** The owner reaches every machine easily. Nothing on a
   machine reaches into the box without a credential the owner issued for it.
   **Nothing the sandbox controls reaches any machine**: not a box agent, not a
   compromised sandbox, not script the sandbox serves into the owner's browser,
   not a password or code the owner typed into a page the sandbox serves.
2. **A compromised box is a bad day, not a catastrophe.** The box is a public
   web app on a shared VPS. A compromised box — gate included — cannot act on a
   machine while the owner is away, cannot widen what the machine allows,
   cannot un-pause it, and cannot push it code.
3. **Lightweight.** On a machine: no root or admin, no WSL, no Node.js, no
   Docker requirement, no keyring, no native add-ons, no listening network
   port. One download, one command.
4. **Reuse before rebuild.** The node serves the bridge's own HTTP and WebSocket
   API, so the Workbench's terminal, agent and Files components work against a
   machine with only an API base changed.

## Decisions taken

| Question | Decision |
| --- | --- |
| Where agents run | On the machine, as the owner (full access, as Claude Code by hand) |
| Platforms in v1 | Linux and Windows (macOS not excluded, not built) |
| How machines are reached | A separate hostname served only by the gate |
| Second factor for machines | A **machines passphrase**, set on the host, never typed on the main origin |
| Who checks the owner is present | **The machine itself**, by a challenge only the passphrase can answer |
| Codex | **Not in v1** — its ChatGPT sign-in cannot be shared across machines (single-use refresh tokens; OpenAI says not to share `auth.json`), and interactive Codex ignores `OPENAI_API_KEY` |
| Embedding in the Workbench | **None.** Machines always open in a tab of their own; the Workbench has a link |

## Non-goals (v1)

- Compute jobs (A); box agents driving a machine or handing it a task.
- Codex on machines (an owner can still install and sign it in by hand).
- Copy between box and machine in the UI (`agentbox files` covers it).
- Usage meters for a machine's agents.
- macOS.
- Containing a machine's agents (they run as the owner).
- Joining one machine to two boxes (refused).

## Words

- **Box** — the agentbox deployment (proxy, gate, sandbox).
- **Machine** — a computer the owner has joined. **Node** — agentbox's program
  on it. **Link** — the node's one outbound WebSocket to the gate.
- **Main origin** — `https://<domain>`; serves the sandbox's pages, as today.
- **Machines origin** — `https://<machines host>`; served only by the gate.
- **Machine-apps origin** — `https://<machine-apps host>`; where apps running
  on machines are shown, under the app policy.

Both new hostnames are configured (`AGENTBOX_MACHINES_HOST`,
`AGENTBOX_MACHINE_APPS_HOST`), not derived: Cloudflare's Universal SSL covers
only first-level subdomains, so `machines.work.example.com` would have no
certificate behind Cloudflare. For the owner's box: `machines.jabezpaul.tech`
and `mapps.jabezpaul.tech`. Without both set, the feature is off and every
machines route answers `404`. A box reached by IP or `localhost` cannot have
it.

## Threats that shape the design

1. **The sandbox serves script into the owner's browser on the main origin**
   (`docs/security.md`, "What a compromised sandbox can still do"). So nothing
   on the main origin may open a machine — not its session, not its pages, not
   a frame of the machines UI it controls.
2. **The sandbox can read what the owner types on the main origin**, including
   the password and two-factor codes typed into the app's Settings screens,
   which the sandbox serves. So the main password and TOTP are **not enough**
   to open machines: the machines origin needs the machines passphrase, which
   is set on the host and only ever typed on the machines origin.
3. **The gate itself may be compromised** (it is a public web service). So the
   machine, not the gate, checks that the owner is present before any terminal
   or file channel opens (Presence), and the machine verifies every update's
   signature itself.
4. **A machine may be compromised or impersonated.** So a machine's responses
   never get to set headers on the machines origin, its apps are on another
   hostname, and nothing a machine sends can reach another machine or the box.

### The machines origin's rules

`<machines host>` and `<domain>` are usually the same *site*, so the browser
sends the machines cookie on requests script on the main origin makes there.
On the machines origin the gate therefore:

- accepts requests only through the proxy (`viaProxy`); the sandbox reaching
  the gate's internal listener directly with a machines `Host` gets `421`;
- refuses every method but GET/HEAD, and every WebSocket upgrade, unless
  `Origin` is exactly the machines origin; it also requires
  `Sec-Fetch-Site: same-origin` when the header is present (Chromium has sent
  none on WebSocket handshakes);
- keeps every GET free of side effects;
- sends on every response, whatever produced it: `Cross-Origin-Resource-Policy:
  same-origin`, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: frame-ancestors 'none'`,
  `Cross-Origin-Opener-Policy: same-origin`, `Origin-Agent-Cluster: ?1`,
  `Referrer-Policy: no-referrer`; and no `Access-Control-Allow-*` at all;
- serves its UI with `script-src 'self'`, registers no service worker and
  refuses any request with `Service-Worker: script`;
- accepts only its own cookie: a session cookie is `__Host-`, `Secure`,
  `HttpOnly`, `SameSite=Strict`, and carries an audience (`machines`); a main
  session, a person token or a node token are refused there.

Nothing frames the machines UI, so there is nothing to overlay. The residual
risk is the ordinary one: a lookalike page the sandbox serves on the main
origin asking for the machines passphrase. Mitigations: the passphrase is only
ever asked for on the machines origin, the UI says so every time, and
`docs/machines.md` tells the owner to type it only into a tab whose address
bar reads the machines host.

## Architecture

```
browser ─(main origin)──────▶ proxy ─▶ gate ─▶ sandbox            (unchanged)
browser ─(machines origin)──▶ proxy ─▶ gate ═▶ node ─▶ herdr, files
browser ─(machine-apps origin)▶ proxy ─▶ gate ═▶ node ─▶ 127.0.0.1:<registered port>
node ─(outbound wss, node token)─▶ proxy ─▶ gate                  (the link)
machine's CLI (person token) ─▶ proxy ─▶ gate ─▶ sandbox          (unchanged)
sandbox ─▶ gate internal listener with a machines Host ─▶ 421
```

The link terminates in the gate. The bridge and the sandbox are on no machine
path. With internet egress the sandbox can still reach the proxy like any
anonymous client; it then holds no credential the machines origin accepts.

### The gate learns hostnames

Today the gate routes on path alone and treats any `Host` as the main origin.
New, before anything else is built:

- `classifyHost(req)`: exactly `main`, `machines` or `machine-apps` from the
  configured hostnames, else `421`.
- Every gate route is tagged with the hosts it serves; a route without a tag
  serves none (default deny). Existing routes are tagged `main`.
- Sessions, grants and tokens carry an audience; each host accepts only its
  own.
- Machine apps have a registry of their own, separate from the box's: the
  sandbox's app API (`:7901`) and the main origin's `/_gate/apps` never see
  them.

### Components

**1. The node** — a mode of the existing CLI (`web/cli`).

- Two forms: the existing `agentbox.mjs` (Node 20+), and a **standalone
  executable** per platform (Node's single-executable application, bundled as
  CommonJS) for machines without Node: Linux x64/arm64, Windows x64. It is
  large (about 90–120 MB; it carries the Node runtime) — the price of needing
  nothing else.
- Commands: `agentbox node join | run | status | pause | resume | leave | logs |
  passphrase`, and on a machine `agentbox-preview <port>` (the box's verb).
- `node run` holds the link, supervises a local herdr, runs the node's HTTP
  server, enforces the policy, and answers presence challenges.
- The node's HTTP server is **not listening on any port**: the link hands it
  each incoming byte stream (`server.emit("connection", stream)`). It serves
  the bridge's API — herdr RPC (through the bridge's RPC allowlist), the
  terminal WebSocket, Files — from code shared with the bridge.
- A local control socket for `agentbox-preview`, `status`, `pause`: a Unix
  socket in the node's `0700` folder, or a named pipe with an owner-only ACL on
  Windows. Never TCP.

**2. The gate's machines side** — new modules in `web/gate`: host
classification; the machines session and passphrase; the handoff; the link
endpoint `/_gate/node`; the registry; the router that dials a byte stream over a
link and reuses the gate's existing `proxyHttp` / `proxyUpgrade` over it; the
machine-apps registry; the audit log; the machines UI's static files.

**3. The machines UI** — a second entry in `web/app`'s build, using the same
terminal, agent-list and Files components against an API base of
`/m/<machine id>/`. Built in CI into the gate's image. Pages: Machines (list,
specs, state), a machine (workspaces and agents, terminals, Files, Preview),
Admin (join approvals, revoke, Claude sign-in, audit log).

**4. Workbench** — a "Machines" link in the box's navigation, opening the
machines origin in a new tab (`rel="noopener noreferrer"`). No frame.

## Files on a machine

All in the node's folder — `~/.local/share/agentbox/node/` (Linux),
`%LOCALAPPDATA%\agentbox\node\` (Windows) — `0700`, files `0600`, owner-only
ACLs on Windows:

| File | Holds | Written by |
| --- | --- | --- |
| `policy.json` | what the box may do here | the owner (and `join`, once) |
| `credentials.json` | node token, machine id, box URL, presence verifier | `join`, `passphrase` |
| `secrets/claude-token` | the shared Claude token, when this machine opted in | the node, from the link |
| `bin/` | herdr, Claude Code, the node itself | the node, verified |
| `state/` | Files trash and upload state, local audit log | the node |

### `policy.json`

```json
{
  "terminals": true,
  "files": [{ "path": "~/code", "mode": "write" }],
  "ports": true,
  "share": false,
  "updates": "auto",
  "presenceHours": 12,
  "paused": false
}
```

- `terminals` — the box may attach to and create herdr panes, agents included.
- `files` — folders the box may browse, each `read` or `write`. `join` asks
  which project folders to allow; it never defaults to the whole home folder.
- `ports` — the box may proxy ports the node has registered as apps (never one
  the box names).
- `share` — an app here may be made public. Honest limit: the gate decides who
  it proxies, so this restrains an honest gate only; the node refuses to
  register an app as shareable when it is `false`, which is what it can do.
- `updates` — `auto`, `notify` or `off` (below).
- `presenceHours` — how long one proof of presence lasts (1–24, default 12).
- `paused` — the link stays down until `resume`.

The node reads it at start and watches it: when it tightens, channels it no
longer allows are closed within 2 seconds. Missing or unparseable: everything
denied, said in `status` and the log, and the link still connects so the owner
sees why in the browser. Re-joining never rewrites an existing `policy.json`.

**Never writable from the box**, whatever `files` says (writes refused,
reads allowed unless also hidden): the node's own folder; shell profiles
(`~/.bashrc`, `~/.profile`, `~/.zshrc`, `~/.config/fish`, PowerShell
profiles); autostart locations (`~/.config/systemd/user`, `~/.config/autostart`,
the Windows Startup folder); `~/.ssh/authorized_keys`, `~/.gitconfig`. With
`terminals` off, this is what keeps "write a file" from becoming "run code".

**Never visible from the box**: `~/.ssh`, `~/.gnupg`, the agentbox config
folders, Claude Code's credentials and the node's `CLAUDE_CONFIG_DIR`, browser
profile folders, `%APPDATA%\Microsoft\Credentials` and
`%LOCALAPPDATA%\Microsoft\Credentials`. Checked on the resolved real path,
case-insensitively on Windows and macOS, after refusing UNC paths, device
paths (`\\.\`, `\\?\`), alternate data streams (`:` after the drive), and
trailing dots or spaces.

## The link

`wss://<domain>/_gate/node` on the **main** hostname (it carries no browser
cookie, so its host does not matter, and it needs no extra certificate), with
`Authorization: Bearer <node token>`. A node token is accepted nowhere else;
nothing else is accepted there. Through the proxy only (`viaProxy`).

- **Framing.** Each message: 1-byte type (`open`, `data`, `close`, `window`,
  `control`), 4-byte stream id, payload. Control payloads are JSON, at most
  64 KiB.
- **Streams.** The gate opens a stream per incoming HTTP connection or
  WebSocket upgrade bound for that machine; the node hands it to its HTTP
  server, which accepts or refuses by policy and presence. One stream carries
  a keep-alive HTTP connection's many requests, so a dev server's hundred
  module requests ride a handful of streams.
- **Flow control.** Per-stream window of 256 KiB, and a gate-wide in-flight
  budget of 64 MiB across all links (the gate's memory limit is 256 MB). Past
  the budget, new streams queue (up to 30 s) rather than fail.
- **Hello.** On connect the node sends: protocol version, node version,
  platform, arch, hostname, CPU, RAM, disk free per allowed folder, GPUs
  (`nvidia-smi` / `rocm-smi` when present), Docker present, Claude Code
  version, the policy summary. The gate answers `ok`, `upgrade` (with the
  minimum version), `duplicate` or `revoked`. Bounded: hello at most 16 KiB,
  control messages at most 20 per second per link.
- **Heartbeat.** WebSocket ping every 25 s each way. Two missed: the gate marks
  the machine offline and ends its streams with a "machine offline" notice.
  The node detects a wall-clock jump (wake from sleep) and reconnects at once,
  otherwise with backoff from 1 s to 60 s, jittered.
- **One link per machine.** A second connection with the same token while the
  first still answers a ping is refused with `duplicate`, shown in the UI and
  the audit log; the duplicate backs off for 5 minutes. A stale first link
  (no pong in 5 s) is replaced.
- **What is a `revoked`.** Only the gate's signed control message `revoked`,
  over an established link. An HTTP 401, a captive portal, or a proxy page are
  network failures: the node keeps its token and retries (hourly after an
  hour), and never deletes anything on its own.
- **Limits.** 32 machines per box, 256 streams per link, 64 registered apps per
  machine; each refused with a clear message past it.

### Responses from a machine

A machine's answers reach the browser only through the gate, which rebuilds
their headers. For `/m/<id>/…` on the machines origin:

- only `Content-Type` from an allowlist (`application/json`,
  `application/octet-stream`, `text/plain; charset=utf-8`), plus
  `Content-Length`, `Content-Range`, `ETag`, `Last-Modified`, `Cache-Control`;
  a download always gets `Content-Disposition: attachment`;
- every other header dropped — `Set-Cookie`, `Location`, `Access-Control-*`,
  `Content-Security-Policy` included — and the machines origin's own headers
  (above) plus `Content-Security-Policy: sandbox; default-src 'none'` added;
- anything else (an HTML body, a redirect) is replaced by `502`.

Machine apps are on the machine-apps origin, under the box's app policy
(below), never the machines origin.

## Presence: the machine checks the owner is there

The gate can be compromised; so before a machine opens a **terminal**, a
**herdr** (agents) or a **Files** channel, it wants proof that the owner, with
the machines passphrase, is at a browser now. The gate cannot produce that
proof.

- **Enrolment, on the machine.** `agentbox node join` asks for the machines
  passphrase in the machine's own terminal, derives `K = PBKDF2-SHA256(pass,
  salt, 600 000)` with a fresh random salt, and keeps `salt` and `K` in
  `credentials.json`. The box never sees `K` or the salt in a form it could
  replace. `agentbox node passphrase` changes it on the machine.
- **Proof, in the browser.** The machines UI (a tab on the machines origin)
  holds the passphrase only in that tab's memory (and `sessionStorage`, so a
  reload does not ask again). For each machine, it asks the node for its salt
  and a fresh challenge (32 random bytes, valid 60 s, single use), derives `K`
  with WebCrypto, and answers `HMAC-SHA256(K, challenge ‖ session id ‖ machine
  id)`.
- **Grant, from the node.** On a correct answer the node issues a grant bound
  to that machines session id, lasting `presenceHours` or until 30 minutes
  without a channel. The gate presents it on each new stream; the node checks
  it. A wrong answer is counted; five in ten minutes lock presence for that
  machine for 15 minutes (said on the machine and in the UI).
- **What it buys.** A compromised gate holding a valid machines session still
  cannot open a terminal, agents or files on a machine unless a grant for that
  machine is live — that is, within `presenceHours` of the owner last proving
  presence there (it can keep a grant from idling out, not extend it). Lower
  `presenceHours` narrows that window. **The honest limit:** a compromised gate
  serves the machines UI, so it could capture the passphrase the next time the
  owner types it there. A passkey would close that; the owner chose a
  passphrase for v1.
- **Not gated by presence:** the machine's appearance in the list, its specs,
  and its apps on the machine-apps origin (each app is opened through a
  machines session and a grant the gate mints, as the box's apps are).

## The machines session

- **Turning machines on**, on the host only: `sudo ./scripts/agentbox machines
  enable --machines-host machines.example.com --apps-host mapps.example.com`
  asks for the machines passphrase on the terminal and pipes it to the gate's
  CLI over stdin (no file, no argument), as `passwd` does. The gate stores a
  bcrypt hash (cost 14). The same command changes it later; `machines disable`
  turns the feature off and ends every machines session and link.
  The installer learns the hostnames as flags and wires them into every proxy
  mode (standalone, behind-proxy, Traefik, passthrough).
- **Signing in** needs a valid main session **and** the machines passphrase.
  1. The machines origin, with no machines session, sends the tab (top-level)
     to `GET https://<domain>/_gate/machines/handoff` — a gate route on the
     main origin. With no main session that goes through `/login` first, and
     `/login` is taught to return to this one route (today it refuses any
     `/_gate/*` destination).
  2. The gate checks the main session, stores a nonce (random, single use,
     60 s, bound to that main session) and redirects to
     `https://<machines host>/signin?n=<nonce>` (`Referrer-Policy:
     no-referrer`).
  3. The sign-in page (gate-served, unframable) asks for the machines
     passphrase and posts it with the nonce, same-origin. The gate checks the
     nonce is unused and its main session still valid, checks the passphrase
     (rate-limited as sign-ins are), and sets the machines session.

  The nonce alone opens nothing, so its appearing in a URL does not matter.
  Sandbox script can start the flow, but cannot finish it without the
  passphrase.
- **Lifetime.** 12 hours, 30 minutes idle; ended by sign-out, by changing the
  main password or the machines passphrase, by `gate revoke-all`, and by
  `machines disable`. Sessions survive a gate restart (they are in the store),
  as main sessions do.

## Joining

```
agentbox node join https://work.example.com
```

1. **Check what can be checked locally**: platform supported, the node folder
   writable, enough disk for herdr and Claude Code.
2. **Install and verify first** (so a failure leaves no token behind): herdr
   and, unless present and new enough, Claude Code, into `bin/`, each checked
   against the pinned digests in the node's signed release manifest (below).
3. **Passphrase.** The CLI asks for the machines passphrase (typed on this
   machine) and derives the presence verifier.
4. **Approve.** The CLI starts a **machine** join at the gate (a record kind of
   its own, distinct from device logins) and prints a code — it does not open a
   link with the code in it. The owner opens the machines origin's Admin page,
   which lists pending joins with the name the machine asked for, its platform
   and hostname as reported, and **the IP address the gate saw**, and types the
   code shown on the machine. Approving needs a machines session; pending joins
   expire after 10 minutes, at most 3 at a time.
5. **Token.** The CLI collects a node token, exactly once; the gate stores a
   digest, bound to a new machine id. A name already in use gets a suffix
   (`laptop-2`); the URL always uses the id.
6. **Policy.** `join` asks which project folders to allow and writes
   `policy.json` — only if none exists — then prints it.
7. **Service.** Registers and starts it (below), and waits until the machine
   shows online.

**Re-joining** in place (same machine, new token) requires proof of the old
node token; without it, it is a new machine, and the old entry stays until the
owner removes it. A machine already joined to another box refuses to join a
second.

## Claude Code on a machine

- **Installed by the node** when missing or older than the pinned version:
  downloaded directly from Anthropic's release store
  (`downloads.claude.ai/claude-code-releases/<version>/…`), checked against
  the SHA-256 in the node's signed manifest, into `bin/`. The vendor installer
  is not used (it always fetches the latest and installs elsewhere). Minimum
  version 2.1.225 (earlier ones could swap in a stored login's token on a
  `401`). The node runs it with `DISABLE_UPDATES=1`; the node updates it.
- **Its own config folder.** The node starts Claude Code with
  `CLAUDE_CONFIG_DIR=<node folder>/claude`, pre-seeded with
  `hasCompletedOnboarding: true` — without that flag a fresh Claude Code shows
  its first-run screens and a browser sign-in even with a token set. The
  owner's own `~/.claude` is not read or written; the agents' settings and
  history on a machine are agentbox's, apart from the owner's.
- **Signed in once.** The owner runs `claude setup-token` once (a one-year
  token for their own subscription) and pastes it on the machines origin's
  Admin page. The gate keeps it in a write-only secrets file of its own, never
  in `gate.json`, never sent anywhere but to nodes. Each machine **opts in** on
  the Admin page before it is pushed there. The node writes it to
  `secrets/claude-token`, and a small `claude` shim, first on `PATH` inside the
  node's herdr, reads it at each launch and execs the real binary with
  `CLAUDE_CODE_OAUTH_TOKEN` set — so it is not in the environment of every
  shell and dev server, and a replaced token reaches the next launch (the UI
  lists agents still running on the old one). If the owner has not opted the
  machine in, Claude Code there signs in on its own the first time
  (`/login`, in the machine's terminal).
- **Revoking a machine** wipes `secrets/` at the next link (and `leave` wipes it
  locally); because the machine may have kept a copy, the UI tells the owner
  to replace the shared token. Phase 0 tests how revocation at claude.ai
  behaves.
- **What it is told.** The node starts Claude Code with
  `--append-system-prompt-file <node folder>/agents.md` — agentbox's
  instructions for machines (where it is, `agentbox-preview`, never make
  anything public, Docker and ports are the machine's own).
- **Limits to document.** A setup token signs model requests only (no Remote
  Control, no claude.ai connectors), and `/usage` shows only the session and
  weekly bars. Using one's own subscription token on one's own machines is
  ordinary use; a hosted service storing other people's tokens would not be
  (relevant to any hosted offering later).

## Using a machine

**Agents and terminals.** Machines origin → gate → link → node's HTTP server →
local herdr, through the bridge's terminal and RPC code. The owner sees the
machine's workspaces, tabs, panes and agents live, creates a workspace in an
allowed folder (or, with `terminals` on, any folder), and starts Claude Code
there. herdr keeps them running; on the machine, `HERDR_SOCKET_PATH=<node
folder>/herdr.sock herdr` (printed by `node status`) attaches to the same
sessions. After a restart with no browser attached, the node attaches a
headless client at 200×50 so restored agents resume.

**Files.** The `files` folders, each `read` or `write`: browse, open in the
editor, upload, download, rename, delete. Delete moves to `state/trash/` in the
node folder (kept 7 days), not the machine's system trash. The bridge's file
service generalises from its two fixed roots to N roots with per-root modes
and a per-root state folder moved into the node folder.

**Preview.** An agent runs `agentbox-preview 3000` (or `start -- npm run dev`).
The node registers the app with the gate's machine-apps registry; it appears in
the owner's Preview at `https://<machine-apps host>/<app id>/`. The box's app
policy applies there unchanged — opaque origin (`APP_SANDBOX`), cookie
rewriting, dropped headers, its scoped CORS — on a hostname that holds no
session for anything else. Only registered ports; the node tries
`127.0.0.1`, then `[::1]`, and never follows a redirect. A registration ends
when its listener closes for 60 s or the node restarts. Sharing needs
`share: true` and the owner's action.

**Machine → box.** The owner's own `agentbox login` on the machine. Agents run
as the owner, so they can use that sign-in too; a machine without it gives its
agents no way into the box. The node token never grants it.

## Running as a service

| | Linux | Windows |
| --- | --- | --- |
| Start | systemd **user** unit | per-user Run entry (`HKCU\…\Run`) starting a small GUI-subsystem stub that starts the node with no window |
| Logged out | `loginctl enable-linger` (allowed for oneself under default polkit; where it is not, `join` says the node runs while logged in, or offers an `@reboot` crontab line) | runs while the user is signed in; shown as "offline (signed out)" |
| Crash | `Restart=on-failure` | the stub restarts it, with backoff |
| Logs | journald, `agentbox node logs` | `state\node.log`, rotated at 10 MB × 3 |
| Shell | `$SHELL` | `pwsh` if present, else Windows PowerShell |

Every child the node starts on Windows is spawned with `windowsHide`. The node
supervises herdr: restarts it if it exits, and checks its control socket every
30 s (a listener can die while the process lives), restarting after two failed
checks.

## Updates

**The box cannot choose what runs on a machine.**

- Each release publishes a manifest — version, and per platform the node's,
  herdr's and Claude Code's URL and SHA-256 — signed in CI with an ed25519
  release key. The node has two public keys built in (current and next), so
  the key can be rotated without trusting anything new.
- The node fetches the manifest from **GitHub Releases**, not the box, verifies
  the signature, and refuses any version not newer than the one running (no
  rollback). It checks daily and when the gate answers `upgrade`.
- `updates: auto` applies it; `notify` tells the owner; `off` does nothing (and
  the gate's `upgrade` then shows "update needed" in the UI).
- The node binary is replaced and restarted at once; herdr only when no agent
  is running, else at the next idle moment (agents live in herdr).
- On a machine with a node, the box-served CLI update (`agentbox update`, and
  `/cli/install` for the node) is disabled: the node updates only from signed
  releases.

## When things go wrong

| Event | Behaviour |
| --- | --- |
| Machine sleeps or loses network | link drops; agents keep running; offline after two missed pings; reconnect at once on wake, else backoff |
| Box or gate restarts | nodes reconnect; machines sessions survive (store) |
| Box restored from an old backup | the node token is unknown: the gate cannot send a signed `revoked` for it, so the node sees refusals and retries hourly, keeping its files; the owner re-joins |
| Captive portal / proxy page / 401 | network failure, not revocation; retry |
| `pause` | link closes now, stays closed until `resume`; gate shows "paused on the machine" |
| Revoked | link closes with `revoked`; node wipes `secrets/`, stops, keeps the rest, says so |
| `leave` while offline | local removal succeeds; the gate shows "left (unconfirmed)" until removed |
| Policy tightened while in use | disallowed channels closed within 2 s |
| Policy file broken | everything denied; link connects; UI shows why |
| Duplicate link | refused while the first answers; alerted |
| Update fails verification | keep the running version; report it |
| herdr dies or hangs | supervised restart; terminal views reconnect; agents resume |
| Shared token replaced | next launches use it; UI lists agents on the old one |
| Machines passphrase changed on the host | machines sessions end; each machine keeps its own verifier until `agentbox node passphrase` on it (the UI says which machines need it) |
| Same name twice | suffixed; URL uses the id |
| Gate stream budget reached | new streams queue up to 30 s, then `503` |
| Cookies for the main domain overflow request headers | `431`; documented ("clear this site's cookies") |
| Hostnames not configured | machines off; every machines route `404` |

## Windows

No WSL, no admin.

- **herdr**: the pinned release's `herdr-windows-x86_64.zip` (herdr.exe plus its
  ConPTY runtime), digests pinned by agentbox (herdr publishes none). Its
  control socket is a named pipe speaking the same NDJSON (Node's
  `net.connect` reaches it). Terminal streaming uses `terminal session
  control` over stdio, which the bridge already uses; phase 0 confirms it on
  Windows. No x64 emulation promise for Windows on Arm.
- **Claude Code**: Anthropic's signed `win32-x64` build. Git Bash is optional
  (Claude Code uses PowerShell without it); none is installed.
- **Smart App Control**: Windows 11 with it on blocks unsigned executables,
  which the node and herdr are. Phase 0 measures it; the decision (Authenticode
  signing, or documenting Smart App Control as unsupported) is made before the
  Windows phase.
- **Paths**: `/`-style in the API; drives as roots; the path rules in "Files
  on a machine".

## Testing

| Layer | Proves |
| --- | --- |
| Unit | host classification and route tags (an untagged route serves nothing); audiences; framing, windows, budget; policy parsing, deny-on-broken, watch-and-tighten; write-deny and hidden lists on realpaths, Windows path forms; node token refused everywhere but the link; presence (salt, challenge single-use and expiring, HMAC binding, lockout); manifest signature, no rollback, key rotation; response header rebuilding |
| `tests/proxy/gate-bypass.sh` (extended) | on the machines origin: cross-origin and same-site writes and upgrades refused; every response unframable with CORP/COOP/nosniff; main session, person token and node token refused; machines cookie never forwarded to the sandbox; sandbox-direct requests with a machines `Host` get `421`; the machines routes `404` when not configured |
| `tests/proxy/topology.py` (extended) | the machines and link surfaces exist only on the gate; the sandbox's paths to the gate are unchanged |
| Fidelity suite (extended) | a machine's app runs in an opaque origin on the machine-apps host and can read nothing on the machines origin |
| End to end, Linux (CI) | the stack plus a "machine" container running the standalone binary: `machines enable` → join (typed code, passphrase) → online with specs → presence → terminal command → workspace with a stub agent → Files read/write and a refused write to `~/.bashrc` → `agentbox-preview` → pause/offline → resume → tighten policy mid-session → revoke |
| End to end, Windows (CI) | `windows-latest` runs the node against a **protocol stub** of the gate's link (the gate itself does not run on Windows); join, the named pipe, terminal, Files path rules, Run entry added and removed |
| By hand | the owner's box, the owner's Linux laptop, a Windows machine |

## Phases

The phased build, its order and each phase's acceptance checks are in
`2026-11-13-machines-plan.md`.

## Later: compute jobs (A)

A `job` stream to the node's HTTP server: run a command in a container on the
machine (`docker run --gpus …`, only the job's folder mounted), stream its
logs, return its outputs; placement reads the registry's specs. Whether box
agents may submit jobs — the first path from the sandbox towards a machine —
is A's central question, to be designed then: a narrow job API on the gate,
node policy (`jobs`, an image allowlist), presence or explicit approval.
