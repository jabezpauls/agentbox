# Machines

Machines are your own computers — a laptop, a home server, a GPU box, a
Windows PC — joined to your box. From the browser you open one and work
there: Claude Code runs **on that machine**, in its folders, with its Docker,
its `npm` and its ports; you browse and edit its files; an app an agent starts
there shows up in a Preview. Linux and Windows are supported.

Machines are off until you turn them on. They live on an origin of their own,
which the gate serves alone: nothing in the sandbox — not an agent, not a page
it serves, not a compromised sandbox — can reach a machine. The design is
`docs/design/2026-11-13-machines-design.md`; the security model is
[below](#what-a-compromised-box-can-and-cannot-do) and in
[docs/security.md](security.md#machines-off-unless-both-hostnames-are-set).

- [Turning machines on](#turning-machines-on)
- [Joining a machine](#joining-a-machine)
- [Using a machine](#using-a-machine)
- [`policy.json`](#policyjson)
- [Commands on a machine](#commands-on-a-machine)
- [Limits](#limits)
- [What a compromised box can and cannot do](#what-a-compromised-box-can-and-cannot-do)
- [Troubleshooting](#troubleshooting)

## The one rule

**Type the machines passphrase only into a tab whose address bar reads your
machines host** (say `machines.example.com`), or into a machine's own
terminal. Never into the box's own pages, never into a page that a link in the
box opened for you, never into a dialog that appears over the Workbench.

The box's own origin serves pages the sandbox controls; the sandbox can read
what you type there, the main password included. That is why machines need a
second secret, and why that secret is only ever asked for on the machines
host. Every place agentbox asks for it says so.

## Turning machines on

You need a box with its own domain (`install.sh --domain`); a box reached by
IP or `localhost` cannot have machines. Machines take two more hostnames:

| | Example | What it serves |
| --- | --- | --- |
| Machines origin | `machines.example.com` | the machines UI, sign-in, Admin; a machine's terminals and files |
| Machine-apps origin | `mapps.example.com` | apps running on machines (Preview), under the box's app policy |

All three — the box and these two — must be different names.

**1. DNS.** Point both new names at the server, as you did the box's domain
(`A`/`AAAA` records, or `CNAME`s to the box's name). Behind Cloudflare, keep
them **first-level** subdomains of your zone: Cloudflare's Universal SSL
certificate covers `*.example.com` but not `*.work.example.com`, so
`machines.work.example.com` would have no certificate at Cloudflare's edge.
Use `machines.example.com` and `mapps.example.com` instead.

**2. Turn them on, on the server:**

```bash
cd /opt/agentbox
sudo ./scripts/agentbox machines enable --machines-host machines.example.com --apps-host mapps.example.com
```

It asks for the **machines passphrase** (twice, at least 12 characters, never
the sign-in password) on the terminal and pipes it to the gate on stdin — never
in an argument, a file or `.env`. The gate keeps a bcrypt hash. Then it writes
the two hostnames to `.env` (`AGENTBOX_MACHINES_HOST`,
`AGENTBOX_MACHINE_APPS_HOST`) and restarts the gate and the proxy only; the
sandbox keeps running. Run the same command again to change the passphrase:
every machines session ends.

The installer takes the same names (`install.sh --machines-host … --apps-host
…`) and wires them into every proxy mode, but the passphrase is set only with
`machines enable`. Depending on the mode:

- **standalone**: Caddy gets a certificate for each name on its first request.
- **traefik**: the router's rule names all three hosts; your certificate
  resolver must be able to issue for them (or your Cloudflare edge covers
  them).
- **traefik with direct TLS**: Traefik passes TLS for all three through to the
  box's Caddy, which gets its own certificates.
- **behind-proxy**: forward both names to the bind address exactly as you
  forward the domain, with the original `Host` and WebSocket upgrades.

`sudo ./scripts/agentbox machines disable` turns machines off: the passphrase
is forgotten, every machines session and every link ends, the two keys leave
`.env`, and every machines route answers `404` again. Machines already joined
stay in the gate's store and link again when you turn machines back on.

**3. Open it.** In the Workbench, **Machines** in the navigation opens the
machines origin in a new tab. Signing in there needs both a live sign-in to
the box and the machines passphrase: the machines origin sends the tab to the
box (through `/login` if you are signed out), the box hands it back with a
one-time code in the address, and the machines origin's own sign-in page asks
for the passphrase. A machines session lasts 12 hours at most and ends after 30
minutes idle; changing the box's password, two-factor or the machines
passphrase, `gate revoke-all`, and `machines disable` end it too.

## Joining a machine

On the machine, as yourself — no root, no admin, no Node.js, no Docker needed.

**Linux** (x64 or arm64): download the standalone executable from the latest
GitHub release and join:

```bash
mkdir -p ~/.local/bin
curl -fsSL -o ~/.local/bin/agentbox https://github.com/jabezpauls/agentbox/releases/latest/download/agentbox-linux-x64   # or agentbox-linux-arm64
chmod +x ~/.local/bin/agentbox
agentbox node join https://code.example.com
```

The npm CLI (`npm i -g @jabezpauls/agentbox`, Node 20 or newer) has the same
`node` commands, if you would rather run it under Node.

**Windows** (x64): download `agentbox.exe` and
`agentbox-node.exe` from the
[latest release](https://github.com/jabezpauls/agentbox/releases/latest) into
one folder of your own (say `%LOCALAPPDATA%\Programs\agentbox`), and in
PowerShell or Windows Terminal:

```powershell
cd $env:LOCALAPPDATA\Programs\agentbox
.\agentbox.exe node join https://code.example.com
```

`agentbox-node.exe` is the same program without a console window; Windows
starts it at sign-in. Both must stay in that folder. Read
[the Windows limits](#limits) first: a PC other people sign in to is not
supported, and neither is Smart App Control blocking the (unsigned)
executables.

`join` then:

1. checks the platform, the node's folder and free disk space;
2. installs herdr and Claude Code into the node's folder, each checked against
   a SHA-256 pinned in this release (`--no-claude` skips Claude Code, about
   280 MiB); nothing is joined if a check fails;
3. asks for the **machines passphrase, typed on this machine**. The machine
   keeps a key derived from it (PBKDF2-SHA256, 600 000 rounds, its own salt)
   and uses it to check that you are at the browser — see
   [presence](#presence). The box never sees that key;
4. asks the box to join and prints a code. Open the machines origin's
   **Admin** page (`https://machines.example.com/admin`): the waiting machine
   is listed with the name it asked for, its platform, hostname and the
   address the box saw it from. **Type the code shown on the machine** and
   approve. Approve only a machine you recognise. At most 3 joins wait at a
   time, each for 10 minutes; no link ever carries the code;
5. collects its node token, once, and writes `credentials.json`;
6. asks which project folders the box may use (or take `--folder
   ~/code,~/notes:read`), never the whole home folder, and writes
   `policy.json` — only if there is none;
7. registers the node as a service and starts it: a systemd **user** unit
   (`agentbox-node.service`, with `loginctl enable-linger` where allowed, so it
   runs while you are logged out) on Linux; a per-user sign-in entry
   (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, `agentbox-node`) on
   Windows, which runs while you are signed in. `--no-service` skips this; run
   `agentbox node run` yourself.

What it puts on the machine, all in one folder, `0700` (owner-only ACLs on
Windows): `~/.local/share/agentbox/node/` on Linux,
`%LOCALAPPDATA%\agentbox\node\` on Windows.

| File | Holds |
| --- | --- |
| `policy.json` | what the box may do here — yours to edit |
| `credentials.json` | the node token, machine id, box URL, presence salt and key |
| `secrets/claude-token` | the shared Claude token, when this machine is opted in |
| `bin/` | herdr and Claude Code |
| `claude/` | Claude Code's own config folder for the node's agents (not your `~/.claude`) |
| `agents.md` | what the node's Claude Code is told about working on a machine |
| `state/` | the Files trash and upload state, the log on Windows |

The node opens no listening port. It holds one outbound WebSocket to the box
(`wss://<box>/_gate/node`), and a local control socket (a Unix socket in its
folder; on Windows a named pipe whose every request carries a secret from an
owner-only file) for `agentbox-preview`, `status` and `pause`.

A name already in use gets a suffix (`laptop-2`); the machine's address uses
its id, not its name. A machine joined to one box refuses to join another.
Re-running `join` against the same box re-joins in place (same machine, new
token), proving the old token.

## Using a machine

The machines page lists every machine with its state (online, offline,
paused, revoked, left), its specs (CPU, memory, disk free per allowed folder,
GPUs, Docker, Claude Code's version) and a summary of its policy. Opening one
needs presence.

### Presence

Before a machine opens a terminal, agents or files, it wants proof that you,
with the machines passphrase, are at a browser now — proof the box itself
cannot produce. On a machine's page the machines UI asks for the passphrase;
the page derives the machine's key from it and answers a fresh challenge
from the machine (HMAC-SHA256, bound to your machines session and that
machine). The passphrase stays in that tab (and its `sessionStorage`, so a
reload does not ask again); it is never sent to the box.

The machine then grants that session access for `presenceHours` (12 by
default), or until 30 minutes pass with nothing open. Five wrong answers in
ten minutes lock presence on that machine for 15 minutes (`agentbox node
status` there says until when). Lower `presenceHours` to narrow how long one
proof lasts.

The list, the specs, and apps in the Preview are not behind presence.

### Terminals and agents

The **Terminal** tab shows the node's herdr: its workspaces, panes and agents,
live. Create a workspace in a folder (with `terminals` on, any folder), pick a
pane, and run what you like there — `claude` starts Claude Code on the
machine. herdr keeps panes and agents running when you close the tab, when the
machine's link drops, and across the node's restarts. On the machine itself,
`agentbox node status` prints the line that attaches a local herdr to the same
sessions (`HERDR_SOCKET_PATH=… herdr`). The node's herdr is a session of its
own: it never shows your own herdr workspaces.

### Claude Code, signed in once

Agents on a machine run Claude Code 2.1.311 from the node's `bin/` (the node
keeps it updated), with a config folder of its own (`claude/` in the node's
folder) pre-seeded so it starts without its theme picker, login choice or
folder-trust dialog for your home folder. Your own `~/.claude` is not read or
written.

To sign every machine in at once:

1. Anywhere you have Claude Code, run `claude setup-token` and copy the token
   it prints (a one-year token for your own subscription).
2. On the machines origin's **Admin** page, paste it under the Claude
   sign-in. The gate keeps it in a secrets file of its own, never shows it
   again, and sends it to nothing but machines.
3. For each machine that should use it, choose **Share the Claude sign-in**.

An opted-in machine keeps the token in `secrets/claude-token`; a small
`claude` shim, first on `PATH` inside the node's herdr, reads it at each
launch, so it is not in the environment of every shell and dev server.
Pasting a new token reaches each opted-in machine on its link and each new
`claude` from then on; Admin lists machines still holding the old one, and
agents already running keep the token they started with until restarted.
Stopping the share, or revoking the machine, removes the file there.

A machine you have not opted in signs in on its own the first time: run
`claude` in a pane and `/login`.

### Files

The **Files** tab shows the folders in `policy.json`'s `files`, each `read`
or `write`: browse, open in the editor, upload, download, rename and delete.
Delete moves to `state/trash/` in the node's folder, kept 7 days, not to the
system's trash.

Whatever `policy.json` says, some paths are never written from the box (with
`terminals` off, this is what keeps "write a file" from becoming "run code"):

- the node's own folder;
- **every dot file and dot folder directly in your home folder**, and all in
  them — `~/.bashrc`, `~/.profile`, `~/.config` (fish, systemd user units,
  autostart, git), `~/.local` (`~/.local/bin`, Python's `.pth` files),
  `~/.ssh/authorized_keys`, `~/.gitconfig`, `~/.claude`, `~/.npmrc` — and on
  Windows `AppData` as well, PowerShell's profiles in Documents and the
  Startup folder;
- folders on `PATH` inside your home (`~/bin`, `~/go/bin`), desktop entries;
- **anything named `.git`** in any repository (its config, hooks and the rest,
  the `.git` folder itself, or a `.git` file), and a bare repository's hooks;
- any folder that holds one of these, or a hidden path: it is not moved,
  renamed, trashed or replaced with them in it.

Some are never even shown: `~/.ssh`, `~/.gnupg`, agentbox's config folders and
the node's secrets, Claude Code's credentials and the node's Claude config,
browser profiles, and Windows' credential stores; a folder that holds one is
never copied. Both lists are checked on the real path after links are
followed. On Windows, UNC and device paths, alternate data streams, names
ending in a dot or a space, DOS device names, and short (8.3) names with a `~`
and a digit (`PROGRA~1`) are refused outright; the API spells
`C:\Users\you\code` as `/C:/Users/you/code`.

So a policy folder that is your whole home, or a dot folder of its own, is
mostly read-only from the box; list project folders. A repository's files are
writable, its `.git` is not: commit from a terminal (`terminals` on) or on the
machine.

### Preview

Set `"ports": true` in `policy.json` first (`join` writes `false`). Then an
agent — or you, in a pane — starts a server and registers its port:

```bash
npm run dev            # listening on 5173, say
agentbox-preview 5173  # --name web, optionally
```

The **Preview** tab lists the machine's registered apps and opens one at
`https://mapps.example.com/<app id>/`, under the box's app policy: an opaque
origin, its cookies kept to its own path, on a hostname that holds no session
for anything else. Only registered ports are reached, on `127.0.0.1` or
`[::1]`, and redirects are never followed to anywhere else. A registration ends
when the port has not answered for 60 seconds or the node restarts.
`agentbox-preview list` and `agentbox-preview stop <port>` manage them.
`agentbox-preview start -- <command>` (the box's form) is not available on a
machine yet. Apps on machines are private: they cannot be shared.

### From the machine to the box

The node token opens the machine's link and nothing else. To use the box from
the machine — `agentbox attach`, `files`, `forward` — sign in as you would on
any computer (`agentbox login <box>`). Agents run as you, so they can use that
sign-in too; a machine without it gives its agents no way into the box.

## `policy.json`

What the box may do on this machine. Yours: `join` writes it once (when there
is none), and nothing from the box ever changes it. The node watches it: when
it tightens, the channels it no longer allows close within 2 seconds.

```json
{
  "terminals": true,
  "files": [{ "path": "~/code", "mode": "write" }],
  "ports": false,
  "share": false,
  "updates": "auto",
  "presenceHours": 12,
  "paused": false
}
```

| Key | Values | Meaning |
| --- | --- | --- |
| `terminals` | `true` / `false` | The box may attach to and create herdr panes, agents included. |
| `files` | list of `{ "path", "mode" }` | Folders the box may browse, each `"read"` or `"write"`. `~` and `~/…` are your home folder; anything else must be absolute (on Windows, a folder on a drive, like `C:\Users\you\code` or `D:\`). |
| `ports` | `true` / `false` | The box may show apps registered with `agentbox-preview` (never a port the box names). |
| `share` | `true` / `false` | Reserved: apps on machines cannot be shared yet. |
| `updates` | `"auto"`, `"notify"`, `"off"` | Signed updates from GitHub releases: applied, only reported, or not checked. |
| `presenceHours` | 1–24 | How long one proof of presence lasts. |
| `paused` | `true` / `false` | The link stays down until `agentbox node resume`. |

A missing key takes its denying value (`false`, no folders). A file that is
missing, is not valid JSON, has a key this node does not know, or has a bad
value denies **everything**; the link still connects, so the machines page
shows why, as do `agentbox node status` and the log.

## Commands on a machine

| Command | What it does |
| --- | --- |
| `agentbox node join <box> [--name n] [--folder dirs] [--no-service] [--no-claude]` | join this computer to a box (above) |
| `agentbox node status [--json]` | joined to which box, linked or not, paused, the policy's problem if any, the herdr line, a presence lock |
| `agentbox node pause` · `resume` | take the link down until `resume`, and bring it back (sets `paused` in `policy.json`) |
| `agentbox node passphrase` | set this machine's copy of the machines passphrase, after it changed on the box |
| `agentbox node logs [-f]` | the node's log: the journal on Linux, `state\node.log` on Windows |
| `agentbox node leave` | leave the box: tell it if it can be reached, remove the service, the token and `secrets/`; keeps `policy.json` and `bin/` |
| `agentbox node run` | the node in the foreground (what the service runs) |
| `agentbox-preview <port> [--name n]` · `list` · `stop <port>` | show an app on this machine in the Preview (inside the node's herdr; elsewhere `agentbox node preview …`) |

On a machine with a node, `agentbox update` (the box-served CLI) is refused:
the node updates only from signed GitHub releases. It fetches the release
manifest from GitHub (not from the box), checks its ed25519 signature against
keys built into it, never goes back to an older version, and checks each
file's SHA-256 before it replaces anything. It checks daily and when the box
says it needs a newer node.

## Limits

- **Claude's setup token signs model requests only**: no Remote Control, no
  claude.ai connectors, and `/usage` shows only the session and weekly bars.
  Use your own subscription's token on your own machines.
- **Codex is not supported on machines**: its ChatGPT sign-in cannot be shared
  across machines, and interactive Codex ignores `OPENAI_API_KEY`. You can
  still install it and sign it in by hand on a machine.
- **macOS is not supported** yet.
- **Windows**:
  - the executables (`agentbox.exe`, `agentbox-node.exe`, and herdr's
    `herdr.exe`, `conpty.dll`, `OpenConsole.exe`) are **not code-signed**.
    Each is checked against a SHA-256 pinned in, or signed into, the release,
    but Windows cannot tell; SmartScreen may warn on first run, and a PC where
    **Smart App Control** blocks them is not supported for now;
  - **a PC that other people also sign in to is not supported**: herdr's
    control pipe has a global name and Windows' default ACL, so another local
    user could take its name first;
  - x64 only; Windows on Arm is not promised.
- **No root, no admin**: on Linux the node runs while you are logged in unless
  `loginctl enable-linger` is allowed for you (`join` says which); on Windows,
  only while you are signed in ("offline" otherwise).
- At most 32 machines per box, 256 streams per machine, 64 apps per machine.
- Agents on a machine run **as you**, with your full access, as Claude Code by
  hand would; agentbox does not contain them.

## What a compromised box can and cannot do

The box is a public web app on a shared server; plan for it being broken into.
**Anything in the sandbox** — an agent, a dev server, a page served into your
browser on the box's origin — has no way to a machine: the machines origin is
the gate's alone, takes only its own session cookie, refuses every write and
WebSocket not from its own page, and is not reachable from the sandbox's side
of the gate at all (`421`). A password or code you type on the box's pages
does not open it.

**If the gate itself is compromised**, it serves the machines UI and holds
every machines session, so it is a bad day. What it can do:

- see every machine in the list, its specs and policy summary, and its apps;
- open a machine's apps on the machine-apps origin (ports the node registered,
  when `ports` is on) — apps are not behind presence, so whatever a registered
  dev server serves (Vite's `/@fs/`, say) is in reach while it is registered;
- act on a machine **while a presence grant you gave is live** — that is,
  within `presenceHours` of you last proving presence there (it can keep a
  grant from idling out, not extend it);
- take the shared Claude token, which it holds, and push a token — yours or
  one of its own — to any machine, opted in or not (the machine cannot tell);
  new `claude` sessions there would then use it;
- **capture the machines passphrase the next time you type it** into the
  machines UI it serves (a passkey would close this; v1 uses a passphrase),
  and from then on prove presence itself;
- revoke machines, or refuse them service.

What it cannot do, because the machine — not the gate — decides:

- open a terminal, agents or files on a machine with no live grant, while you
  are away;
- widen `policy.json`, un-pause a machine, or switch off its checks;
- write past the never-writable list, or read the never-shown one;
- push code: the node installs and updates only what a release signed with a
  key built into it names, fetched from GitHub, never older than what runs;
- reach a port the node did not register, or make an app public.

**If you suspect the gate**, change the machines passphrase on the host
(`machines enable` again) and then on every machine (`agentbox node
passphrase`), pause the machines you are not using (`agentbox node pause`),
and lower `presenceHours`.

**Apps on the machine-apps origin** are under the box's app policy, residuals
included ([docs/security.md](security.md#what-a-compromised-sandbox-can-still-do)):
an app's grant cookie is `SameSite=None`, because an app's page is an opaque
origin, so a page anywhere that knows an app's id (128 random bits, shown only
on the machines origin) can reach that app as you while you hold a grant for
it — an hour after you last used it. Keep app links to yourself.

**If a machine is compromised or impersonated**, its answers reach your
browser only through the gate, which rebuilds them: no cookie, redirect, CORS
grant, page or header of its own on the machines origin, and anything else is
a `502`. Its apps are on the machine-apps origin, in an opaque origin.
Nothing a machine sends reaches another machine or the sandbox. Revoke it; if
it had the shared Claude token, replace the token too (it may have kept a
copy).

## Troubleshooting

| You see | What it means, and what to do |
| --- | --- |
| **offline** | The link is down: the machine is asleep, off the network, signed out (Windows) or the node is not running. `agentbox node status` and `agentbox node logs` on the machine. It reconnects at once on wake, else with backoff up to a minute. |
| **paused** | Someone ran `agentbox node pause` there (or set `"paused": true`). `agentbox node resume` on the machine; the box cannot un-pause it. |
| **policy: … (everything denied)** | `policy.json` is missing or broken; the message says what. Fix the file; the node reads it again within seconds. |
| **A second link … was refused** | Another copy of this machine's token tried to link while the first answered: a copied node folder, or a stolen token. If it is not yours, revoke the machine and join it again. The copy backs off for 5 minutes. |
| **revoked** | You revoked it: the node wiped `secrets/` and stopped, keeping the rest. Remove it from the list; to bring it back, run `agentbox node join <box>` on it again, which joins it as a new machine. |
| **left (unconfirmed)** | `node leave` ran while the box could not be told. Remove it from the list. |
| **update needed** | The box needs a newer node. With `updates: auto` it updates itself; otherwise download the latest release. |
| A 401 from the link, a captive portal, a proxy page | Network failures, not revocation: the node keeps its token and retries (hourly after an hour). Only a signed `revoked` from the box over a live link stops it. A box restored from an old backup does not know the token: join the machine again. |
| **presence locked** | Five wrong passphrases in ten minutes: wait 15 minutes. If the passphrase changed on the box (`machines enable` again), the machine still knows the old one: run `agentbox node passphrase` on it (a running node takes it at once and ends every grant the old one earned). |
| A write in Files is refused (`permission denied`) | The path is on the never-writable list: a dot file or folder in home, anything in a `.git`, a folder holding one of them. See [Files](#files). |
| **This sign-in has expired** | The one-time code from the box was used or is over a minute old, or your box sign-in ended. Start again from the box. |
| `431 Request Header Fields Too Large` | Your browser sends too many cookies for the box's domain (an app may have set many). Clear this site's cookies and sign in again. |
| Every machines address answers `404` | Machines are off: `sudo ./scripts/agentbox machines enable …`. |
| `421 Misdirected Request` | The request named a hostname the gate does not serve, or reached the gate without going through the proxy. Check DNS and your own proxy's forwarding of both names. |
| A Preview app is not there | `"ports": true` in `policy.json`; the server listening on `127.0.0.1` or `[::1]`; `agentbox-preview list`. A registration ends after 60 seconds without an answer. |
