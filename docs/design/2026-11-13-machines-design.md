# Machines: your own computers, joined to agentbox

Status: design, November 2026, for review. Covers "B" — agents working on a
joined machine — in full. "A" — sending compute jobs (GPU work, heavy builds)
to a machine — is kept in view so nothing here blocks it, but is not built.

## Why

agentbox today is one box: a sandbox on a VPS, reached from a browser or the
`agentbox` CLI. The owner has other computers — a laptop, a home server, a GPU
rig, a Windows PC — and wants them to be part of the same system:

- open a machine from the box's browser UI and work there: run Claude Code or
  Codex **on that machine**, in that machine's folders, with its Docker, its
  `npm`, its ports;
- see an app an agent starts on the machine in the same Preview panel the box
  uses;
- browse and edit that machine's files from the browser;
- and, the other way, use the box from the machine (this mostly exists:
  `agentbox attach`, `shell`, `files`, `mount`, `forward`).

One login for the agents across every machine, and nothing heavy to install.

## Principles

These are requirements, and every later section is checked against them.

1. **Trust goes one way.** The owner, signed in at the box, reaches every
   machine easily. Nothing on a machine reaches into the box without a
   credential the owner issued for that purpose. **Nothing in the sandbox
   reaches any machine at all** — not a box agent, not a compromised sandbox,
   not script the sandbox serves into the owner's browser.
2. **A compromised box is a bad day, not a catastrophe.** The box is a public
   web app on a shared VPS. The machine has the final say over what the box may
   do on it; the box cannot raise that, cannot un-pause a machine, and cannot
   push it code.
3. **Lightweight.** On a machine: no root or admin, no WSL, no Node.js, no
   Docker requirement, no keyring, no native add-ons, no listening port. One
   download, one command.
4. **Reuse before rebuild.** The node speaks the bridge's own API shapes, so the
   Workbench's terminal, agent and Files components work against a machine
   unchanged.

## Non-goals (v1)

- Compute jobs (A). The link and registry are built so A is one more channel
  type later.
- Box agents driving a machine, or handing a task to a machine's agent.
- Drag-and-drop copy between box and machine in the UI (`agentbox files`
  covers it).
- Usage meters for a machine's agents.
- macOS. The design does not exclude it (herdr ships macOS builds; the service
  would be a launchd agent), but it is not built or tested in v1.
- Containing a machine's agents. They run as the owner, with the owner's
  access, as Claude Code does when the owner runs it there by hand. That is a
  deliberate choice (simplest, most capable); a contained mode can come later.

## Words

- **Box** — the agentbox deployment (gate, proxy, sandbox).
- **Machine** — a computer the owner has joined.
- **Node** — the agentbox program running on a machine (`agentbox node run`).
- **Link** — the node's one outbound WebSocket to the box's gate.
- **Main origin** — `https://<domain>`, as today; it serves the sandbox's pages.
- **Machines origin** — `https://machines.<domain>`, new; served only by the
  gate.

## The threat that shapes the design

The Workbench is served from inside the sandbox (`docs/security.md`, "What a
compromised sandbox can still do"): a compromised sandbox can run script in the
owner's browser, on the main origin, with the owner's session. If "this browser
may open a shell on my laptop" rested on that session, a prompt-injected box
agent could plant a page that opens one the next time the owner looks at the
Workbench. Principle 1 would quietly be false.

So machines are reached only through the **machines origin**: a separate
hostname, served entirely by the gate from the gate's own image, with its own
host-only session cookie. Script on the main origin cannot read its pages,
cannot use its session for anything that changes state (below), and cannot
open its WebSockets.

### Same-site is not same-origin

`machines.<domain>` and `<domain>` are the same *site*, so the browser **does**
send the machines cookie with requests script on the main origin makes to the
machines origin (`fetch(..., {credentials: "include"})`, a form post, an
`<img>`, a WebSocket). The gate must therefore, on the machines origin:

- refuse any request other than GET/HEAD, and every WebSocket upgrade, unless
  `Sec-Fetch-Site: same-origin` and `Origin` is exactly the machines origin
  (the gate's existing same-origin check, but `same-site` is **not** enough);
- make every GET free of side effects;
- send `Cross-Origin-Resource-Policy: same-origin` and
  `X-Content-Type-Options: nosniff` on every response it originates, and no
  `Access-Control-Allow-*` except the app policy's own, scoped to one app's
  path (see Preview);
- send `Cross-Origin-Opener-Policy: same-origin` on its top-level pages, so a
  window the sandbox opened cannot keep a handle to them;
- frame its pages only from the main origin (`frame-ancestors <main origin>`),
  and its admin pages from nowhere (`frame-ancestors 'none'`).

The session cookie is `__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`. An
app's opaque-origin page (box or machine) is cross-site, so it never carries it.

### What remains

UI redress: the Workbench (sandbox-served) frames the machines UI, so a
compromised sandbox can draw over the frame, or draw a lookalike, and capture
keys the owner meant for a machine's terminal (a `sudo` password, say). It
cannot reach the machine itself. The mitigations are the same as for the box
today: the machines origin always works in a tab of its own
(`https://machines.<domain>`), which `docs/machines.md` recommends for anything
sensitive, and the Workbench's Machines panel has an "open in its own tab"
control.

## Architecture

```
browser ──(main origin)──────▶ proxy ─▶ gate ─▶ sandbox      (as today)
browser ──(machines origin)──▶ proxy ─▶ gate ═▶ node ─▶ herdr, files, 127.0.0.1:<port>
node ──(outbound wss, node token)───▶ proxy ─▶ gate          (the link)
machine's CLI (person token) ─▶ proxy ─▶ gate ─▶ sandbox    (as today)
sandbox ─╳─▶ gate's node side           (no route, no credential, no endpoint)
```

The link terminates in the gate, outside the sandbox. The bridge and the
sandbox are not on any machine path.

### Components

**1. The node** — a mode of the existing CLI (`web/cli`), no new install.

- Shipped two ways: the existing `agentbox.mjs` (Node 20+) and, new, a
  **standalone executable** per platform (Node's single-executable
  application), so a machine needs no Node. Linux x64/arm64, Windows x64.
- `agentbox node join <box-url> [--name <name>]` — pairs the machine (see
  Joining), installs what is missing, registers the service, starts it.
- `agentbox node run` — the long-running process the service starts.
- `agentbox node status | pause | resume | leave | logs`.
- `agentbox preview <port>` (on a machine) — shows a local port in the owner's
  Preview; talks to the local node over its control socket.
- Holds the link, supervises a local herdr, serves the channels below, and
  enforces the local policy.
- Bundles the bridge's herdr client (`web/bridge/src/herdr/*`) and file service
  (`web/bridge/src/files/*`), moved where needed into a shared workspace
  package so the bridge and the node import the same code. No native add-ons.

**2. The gate's node side** — new modules in `web/gate`.

- `/_gate/node`: the link endpoint (WebSocket, node token only).
- The registry: joined machines (id, name, platform, specs, version, policy
  summary, last seen) in the gate's store; which are connected, in memory.
- The router: maps a machines-origin request for `/m/<machine>/…` onto a
  channel of that machine's link.
- The audit log: every terminal attach, file write, app registration, policy
  report, join, pause, revoke — kept in the gate's store, bounded (last 5,000
  events), shown on the machines origin.
- The machines origin: host routing, its session, the handoff, its pages, and
  the static machines UI.

**3. The machines UI** — a second entry in the Vite build of `web/app`, using
the same terminal, agent-list, Files and Preview components with an API base of
`/m/<machine>/`. Built in CI into the gate's image as static files; the gate
serves it with a strict CSP (`script-src 'self'`). Pages:

- Machines: the list, each with platform, specs, online/paused/offline, last
  seen, agent versions.
- A machine: its workspaces and agents (herdr), terminals, Files, Preview.
- Admin (not framable): join approvals, revoke, the agents' sign-in, audit log.

**4. Workbench integration** — a "Machines" entry in the box's Workbench
navigation that frames `https://machines.<domain>/` in a panel, with "open in
its own tab". The box's Workbench learns nothing about machines; it only knows
the URL.

**5. The local policy** — `node.json` on the machine, beside the node token.
Owned by the owner, readable by them alone, never written by the box.

```json
{
  "terminals": true,
  "files": ["~"],
  "ports": true,
  "share": false,
  "paused": false
}
```

- `terminals` — the box may attach to and create herdr panes (agents included).
- `files` — folders the box may browse; `[]` for none.
- `ports` — the box may proxy `127.0.0.1` ports the node has registered as apps
  (never an arbitrary port; see Preview).
- `share` — an app on this machine may be shared (made public) from the Preview
  panel. Off by default.
- `paused` — the link stays down until `resume`.

Defaults are written at join and shown to the owner before the service starts.
A missing or unparseable file means **everything denied** and the node says so
in `status` and its log; it never runs on a half-read policy. The node reports
a summary of its policy to the gate on connect, for display only — the gate's
copy decides nothing.

Always hidden from Files, whatever `files` says: `~/.ssh`, `~/.gnupg`, the
agentbox config folder, `~/.claude/.credentials.json`, `~/.codex/auth.json`,
browser profile folders, and on Windows `%APPDATA%\Microsoft\Credentials` and
`%LOCALAPPDATA%\Microsoft\Credentials`. This is a seatbelt, not a wall: with
`terminals` on, a shell reaches them anyway. It matters when `terminals` is
off.

## The link

One WebSocket from node to gate: `wss://<domain>/_gate/node`, with
`Authorization: Bearer <node token>`. No other credential is accepted there,
and the node token is accepted nowhere else.

- **Framing.** Each WebSocket message is one frame: a 1-byte type, a 4-byte
  channel id, then the payload. Types: `open`, `data`, `close`, `control`.
  Control payloads are JSON.
- **Channels.** The gate opens channels; the node accepts or refuses each
  against its policy. Kinds: `herdr` (newline-delimited JSON requests to the
  local herdr, filtered by the bridge's own RPC allowlist), `terminal` (one pane
  attach), `files` (HTTP-shaped requests to the file service), `app` (one HTTP
  request or WebSocket to a registered app port), and later `job` (A). The node
  never opens a channel to the gate except for its own registration and app
  registration, both as control messages.
- **Hello.** On connect the node sends `hello`: protocol version, node version,
  platform, arch, hostname, CPU model and count, RAM, disk free per allowed
  folder, GPUs (from `nvidia-smi` or `rocm-smi` when present, else none),
  Docker present, agent versions, the policy summary. The gate answers `ok` or
  `upgrade` (too old: the node updates, then reconnects) or `revoked` (the node
  stops and tells the owner).
- **Heartbeat.** WebSocket ping every 25 s from each side (Cloudflare drops a
  socket idle for 100 s). Two missed: the gate marks the machine offline and
  closes its channels with a "machine offline" notice; the node reconnects.
- **Backpressure.** Per-channel windows (256 KiB in flight); a slow browser
  stalls its own channel, not the link. One link per machine: a second
  connection with the same token replaces the first.
- **Limits.** At most 64 channels open per machine, 32 machines per box; each
  refused with a clear message past the limit.

## Joining

```
agentbox node join https://work.example.com --name gpu-rig
```

1. **Approve.** The CLI starts a device flow, as `agentbox login` does, but the
   approval page is on the **machines origin**
   (`https://machines.<domain>/approve?code=…`), not the main origin — a page
   on the main origin shares its origin with pages the sandbox serves. The CLI
   opens it (or prints it over ssh / with `--no-browser`). The owner checks the
   code and the machine's name, platform and hostname as the CLI reported them,
   and approves with the password **and a two-factor code**. Joining requires
   two-factor to be on: a machine reached through the box's password should
   have a second factor in front of it. The first join tells the owner to turn
   it on. `--allow-without-2fa`, recorded in the audit log, is the override.
2. **Token.** The CLI collects a node token, exactly once. The gate stores its
   digest, bound to a new machine id. Joining the same machine again (same
   machine id in `node.json`) revokes the token it replaces.
3. **Install.** Into the node's folder (`~/.local/share/agentbox/node/` on
   Linux, `%LOCALAPPDATA%\agentbox\node\` on Windows): herdr (pinned,
   checksum-verified, as `scripts/install-herdr.sh` does), and Claude Code and
   Codex **when the machine does not already have them** (each vendor's own
   native, standalone build, downloaded from the vendor at join — agentbox does
   not redistribute them). Versions and checksums are pinned in the node's
   release.
4. **Policy.** Writes the default `node.json` and prints it.
5. **Service.** Registers and starts the service (below), and waits until the
   machine shows online at the gate.

Everything lives in the user's own folders. Nothing needs root or admin; the
one optional exception is Linux's `loginctl enable-linger`, below.

## Tokens and the agents' sign-in

| Credential | Where it lives | What it can do | How it ends |
| --- | --- | --- | --- |
| Node token | `node.json` on the machine, `0600` in a `0700` folder (per-user ACL on Windows) | hold this machine's link | revoke on the machines origin, `agentbox node leave`, re-join |
| Machines session | browser, `__Host-` cookie on the machines origin | use the machines UI | sign out, expiry, password change |
| Person token (exists) | `config.json` | `attach`, `files`, `forward`… into the box | Settings → Devices, `agentbox logout` |
| Shared Claude token | gate store; pushed to connected nodes over the link; held in the node's memory and in `node.json` | sign Claude Code in on every machine | replace or remove on the machines origin; revoke at claude.ai |

**Machines session, without typing the password twice.** Visiting the machines
origin without a session redirects (top-level only) to
`https://<domain>/_gate/handoff?state=<s>`, served by the gate. If the main
session is valid, the gate mints a one-time code (single use, 60 s, bound to
`state`) and redirects to `https://machines.<domain>/_gate/handoff/complete`,
which checks `state` against a cookie the machines origin set before the
redirect, and sets the machines session. Without a main session it goes through
`/login` first. Sandbox script can trigger the redirect, but all it achieves is
giving the owner's own browser a machines session it still cannot use. The
password change and `gate revoke-all` end machines sessions too.

**Claude Code, signed in once.** The owner runs `claude setup-token` once,
anywhere, and pastes the long-lived token into the machines origin's admin page
— never into the Workbench, which the sandbox serves. The gate keeps it and
pushes it to each node on connect and on change. The node starts Claude Code in
its herdr with `CLAUDE_CODE_OAUTH_TOKEN` set; it never writes `~/.claude`. If
the machine's Claude Code is already signed in on its own, that sign-in wins
and the token is not set. A long-lived token does not rotate, so any number of
machines can use it at once without signing each other out (which sharing a
copied `~/.claude` does).

**Codex.** Its ChatGPT sign-in may rotate as Claude's OAuth sign-in does; not
yet verified (phase 0). v1: one `codex login` per machine (it persists), or an
`OPENAI_API_KEY` pasted once and pushed to every machine like Claude's token.

**What a machine's agents are told.** The node starts each agent with
agentbox's instructions for machines (the counterpart of
`images/workspace/agents.md`: where they are, `agentbox preview`, never make
anything public), passed per session — not by editing the owner's own
`~/.claude/CLAUDE.md`. The mechanism per agent is settled in phase 0.

## Using a machine

**Agents and terminals.** Machines origin → gate → link → node → local herdr.
The owner sees the machine's workspaces, tabs, panes and agents live, exactly as
for the box, and can create a workspace in a folder on the machine and start an
agent there. herdr keeps them running whether or not anyone is watching; on the
machine, plain `herdr` attaches to the same sessions with no network. The
browser's terminal is herdr's terminal stream relayed, so the resize rules are
herdr's (last resize wins) as on the box.

**Files.** The machines UI's Files view lists the `files` folders: browse, open
in the editor, upload, download, rename, delete (to the machine's trash). Paths
are confined to the allowed folders after resolving symbolic links, as the
bridge's path guard does, plus the always-hidden list.

**Preview.** An agent on the machine runs `agentbox preview 3000` (or `start --
npm run dev`, as on the box). The node registers the app with the gate; it
appears in the owner's Preview on the machines origin at
`/m/<machine>/a/<id>/`. The gate applies the **box's app policy unchanged**:
opaque origin (`APP_SANDBOX`), cookie rewriting, dropped headers, and its CORS
answer limited to that app's own path. An app on a machine is someone else's
code as much as one in the box, and the machines origin is the more powerful
one. Only registered ports are reachable, never one the box names on its own.
Sharing (public) needs `share: true` in `node.json` *and* the owner's action in
the Preview panel.

**Machine → box.** The owner's own `agentbox login` on the machine gives them
`attach`, `shell`, `files`, `mount`, `forward`. A machine's agents run as the
owner, so they can use that sign-in too; a machine without it gives its agents
no way into the box. The node token never grants it.

## Running as a service

| | Linux | Windows |
| --- | --- | --- |
| Start | systemd **user** unit (`~/.config/systemd/user/agentbox-node.service`) | per-user Run entry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`), started without a window |
| Logged out | needs `loginctl enable-linger <user>` once (may ask for sudo; `join` says when) | runs while the user is signed in |
| Restart on crash | systemd `Restart=on-failure` | the node's own supervisor process |
| Logs | journald, and `agentbox node logs` | `%LOCALAPPDATA%\agentbox\node\node.log`, rotated |
| Shell | `$SHELL` | `pwsh` if present, else Windows PowerShell |

The node supervises herdr: restarts it if it exits, and checks herdr's control
socket every 30 s — a listener can die while the process lives (seen on the
box when it hit its process limit) — restarting it if the check fails twice.
herdr's own session restore brings agents back (`claude --resume`).

## Updates

The node updates itself, herdr and the agents it installed. **The box cannot
choose what runs on a machine**: every node release is signed in CI with an
ed25519 release key whose public half is built into the node, and the node
verifies the signature itself before replacing its own binary, whatever the box
serves or says. herdr and agent downloads are checksum-pinned in that signed
release. A failed verification keeps the running version and is reported. The
node checks for updates daily and when the gate answers `upgrade`.

## When things go wrong

| Event | Behaviour |
| --- | --- |
| Machine sleeps or loses network | link drops; agents keep running locally; gate marks it offline after two missed pings; UI shows "offline, last seen …"; node reconnects with backoff (1 s → 60 s, jittered) |
| Box or gate restarts | nodes reconnect; registry identity is in the gate store, live state rebuilds from `hello` |
| Owner pauses (`node pause`) | link closes at once and stays closed until `resume`; gate shows "paused on the machine"; the box cannot un-pause |
| Node token revoked | gate closes the link with `revoked`; node stops, keeps its files, tells the owner in `status` |
| Node too old | `upgrade`; node fetches, verifies, restarts |
| Update fails verification | keeps running the current version; reported in `status` and audit log |
| herdr dies or hangs | supervised restart (above); open terminal views see "reconnecting" |
| `node.json` missing or broken | everything denied; said in `status` and log; link still connects so the owner sees why |
| Disk full | Files writes fail with the error; uploads abort cleanly |
| Two nodes with the same token | the newer link replaces the older; both recorded |
| Clock skew on the machine | nothing depends on the machine's clock (no signed timestamps); handoff codes and sessions are timed by the gate |
| A channel's browser vanishes | the gate closes the channel; the node releases the herdr attach |
| 32 machines / 64 channels reached | refused with a clear message |

## Windows

No WSL, no admin.

- **herdr** ships `herdr-windows-x86_64` in the pinned 0.9.3. Its control
  channel there (expected: a named pipe) and terminal attach are verified in
  phase 0. If it falls short, the fallback is a small ConPTY-backed terminal
  host inside the node, built on Windows' own API without a native add-on;
  agents would then run without herdr's session persistence on Windows.
- **Claude Code** on Windows has needed Git for Windows (Git Bash). Phase 0
  checks the current release; if it still does, `join` installs **MinGit**
  (portable, no installer, no admin) into the node's folder and points Claude
  Code at it.
- **Starting hidden.** A single-executable console program opens a window when
  started from the Run entry. Phase 0 picks the mechanism (a second, GUI-
  subsystem stub; or `conhost --headless` where supported).
- **Paths** are normalised to `/` in the API; drive letters appear as roots.

## Testing

| Layer | Proves |
| --- | --- |
| Unit (node, gate) | link framing and channel windows; policy: deny by default, broken file denies all, hidden paths, symlink escapes, Windows path forms; node token refused everywhere but `/_gate/node`; tampered or unsigned update refused; handoff code single-use, expiring, `state`-bound |
| `tests/proxy/gate-bypass.sh` (extended) | on the machines origin: cross-origin and **same-site** state-changing requests and WebSocket upgrades refused; CORP on every gate response; admin pages unframable; main-origin cookie ignored there; machines cookie never forwarded to the sandbox |
| `tests/proxy/topology.py` (extended) | no sandbox service can reach the gate's node side; the link is only on the gate |
| Fidelity suite (extended) | a machine's app runs in an opaque origin on the machines origin, in the panel and full screen, and cannot read the machines UI |
| End to end, Linux (CI) | the stack plus a "machine" container running the standalone binary with a real herdr: join with two-factor → machine online with specs → open a terminal, run a command → create a workspace, start a stub agent → Files browse/upload → `agentbox preview` and load it → pause shows offline → resume → revoke stops the node |
| End to end, Windows (CI) | `windows-latest` builds the `.exe`; the gate runs as a Node process beside it; join, link, herdr's pipe, a terminal, Files, the Run entry registered and removed by `leave` |
| By hand | fludigo + the owner's Linux laptop + a Windows machine |

## Phases

Each phase is its own branch and pull request, merged only with CI green. None
restarts the sandbox; deploying phases 1–3 restarts the gate (browsers sign in
again, agents keep running).

0. **Spike (throwaway).** Answer: herdr's control channel and terminal attach on
   Windows; Claude Code on Windows with or without Git Bash; whether Codex's
   ChatGPT sign-in can be shared; `CLAUDE_CODE_OAUTH_TOKEN` in a headless herdr
   pane; passing agentbox's instructions per session to Claude Code and Codex;
   single-executable size and starting it hidden on Windows. Findings amend this
   spec before phase 1.
1. **Link, registry, join, service (Linux).** Node token, `/_gate/node`, `hello`
   and heartbeats, registry and audit log, the machines origin with its session,
   handoff and same-origin rules, the approval page, the Machines list,
   `node join|run|status|pause|resume|leave|logs`, the systemd user unit,
   signed single-executable builds in the release. No channels yet.
2. **Agents and terminals.** Channels and backpressure; the herdr and terminal
   channels; the machines UI bundle in the gate image; agent install; the shared
   Claude token; per-session instructions; the Workbench's Machines panel.
3. **Files, Preview, policy.** `node.json` enforcement, the files channel,
   `agentbox preview`, app channels under the app policy, sharing behind
   `share`.
4. **Windows.** herdr (or the fallback), the Run entry, hidden start, MinGit if
   needed, paths, the Windows CI job.
5. **Hardening, docs, deploy.** `docs/security.md` section, `docs/machines.md`,
   the extended bypass/topology/fidelity suites green, deploy to the owner's box
   (needs a DNS record for `machines.<domain>`; the proxy modes each learn the
   second hostname).

## Later: compute jobs (A)

A `job` channel: the gate asks a node to run a command in a container on that
machine (`docker run --gpus …`, only the job's folder mounted), streams its
logs, and returns its outputs. The registry's specs (GPUs, RAM, Docker) are
what placement reads. Whether box agents may submit jobs — the first time the
sandbox would get a path to a machine — is A's central security question, to
be designed then: a narrow job API on the gate, policy on the node
(`jobs: true`, image allowlist), and the owner's approval.
