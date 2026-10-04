# The agentbox CLI

`agentbox` is your box from your own machine's terminal: herdr's TUI and a
shell in your terminal, files up and down, the workspace mounted as a folder,
and how the box is doing. It is one file of JavaScript that runs on Node.js 20
or newer, and your box serves the build that matches it.

## Install

```bash
curl -fsSL https://work.example.com/cli/install | sh
```

That checks for Node 20+, puts the CLI in
`~/.local/share/agentbox/agentbox.mjs` with an `agentbox` link in
`~/.local/bin`, tells you how to add that folder to your `PATH` if it is not
there, and signs in to the box it came from. The installer prints the line
for your box at the end of `install.sh`. Options go after `sh -s --`:
`--dir <path>` for the link's folder, `--no-login` to sign in later.

The file is named `.mjs` because Node reads it as an ES module only by that
name before releases 20.19 and 22.12; the link keeps the name.

### From npm

The same CLI is published to npm as
[`@jabezpauls/agentbox`](https://www.npmjs.com/package/@jabezpauls/agentbox),
one version per agentbox release:

```bash
npm i -g @jabezpauls/agentbox
agentbox login https://work.example.com
```

Use this on Windows, or anywhere you would rather npm kept track of it. Pick
the version your box runs with `npm i -g @jabezpauls/agentbox@1.2.0` for a box
on `v1.2.0`. (The unscoped `agentbox` on npm is someone else's placeholder,
not this.)

On Windows without npm, download `https://<box>/cli/agentbox.mjs` and run it
with `node agentbox.mjs …`. From a checkout: `cd web && npm ci &&
npm run build -w cli && npm i -g ./cli`.

### Updating the CLI

`agentbox update` replaces the CLI with the build your box serves: it
downloads `/cli/agentbox.mjs`, checks that it is an agentbox build (and not
larger than any build is) and that it starts, and swaps it in with one rename.
From a box on plain http that is not this machine it refuses, since anyone on
the way could swap what runs next; `--insecure-http` says the network is yours.
The install script, likewise, downloads from an https box over https only. Once a day the CLI asks the box which
version it runs (`/_gate/version`) and says so when they differ. A CLI
installed from npm is npm's to replace: there `agentbox update` prints the
`npm i -g @jabezpauls/agentbox@<version>` line that matches the box instead.

## Sign in

```bash
agentbox login https://work.example.com
```

The CLI shows a code and opens your box's `/settings/devices?code=…` page (or
prints it, over ssh or with `--no-browser`) — only ever that page on the
address you typed, whatever the box names. Sign in there if you are not
already, check the code matches, enter your password and approve. The CLI
never sees your password: it collects a **device token** of its own, which
Settings → Devices lists and can revoke.

- `--name <name>` — what to call the box here (default: its first DNS label,
  e.g. `work`).
- `--device <label>` — how the box lists this device (default: `agentbox CLI
  on <hostname>`).

`agentbox logout` revokes the token at the box and forgets it here. If the box
cannot be reached, `logout --local` forgets it anyway; revoke it in Settings
→ Devices. Signing in to the same box again — under its name or a new
`--name` — revokes the token it replaces, and a sign-in the CLI cannot confirm
is revoked rather than kept.

`agentbox whoami` says who and where you are signed in.

A sign-in ends by setting up SSH to the box (`agentbox ssh-setup`, below), and
says what it changed. If that fails — a box from before the SSH endpoint, no
`ssh-keygen` here — the sign-in stands and a warning says so.

### Several boxes

Every box you sign in to is kept by name, and one is current.

```bash
agentbox boxes              # the list; * marks the current one
agentbox use home           # make "home" current
agentbox --box home status  # one command against another box
```

`$AGENTBOX_BOX` does what `--box` does.

### Where the token is kept

In `~/.config/agentbox/config.json` (or `$XDG_CONFIG_HOME/agentbox/`; on
Windows `%APPDATA%\agentbox\config.json`), and nowhere else: the file is
created readable by you alone (`0600`, in a `0700` folder), and if it is ever
found open to others the CLI closes it again and says so. The token is never
printed, `--json` included. Treat the file like an ssh key: anyone who reads it
has your box until you revoke the device. Two `agentbox` commands changing it
at once (a `login` while a `mount` runs) take turns through a lock file beside
it, so neither loses the other's change.

A few uploads may leave `uploads.json` beside it, so an interrupted upload can
resume (see below); it holds upload ids, never a token.

## Commands

Every read command takes `--json` for scripts. Human output goes to stdout,
and messages, progress and warnings to stderr, so `--json` output is always
clean.

| Command | What it does |
| --- | --- |
| `login <url>` · `logout` · `whoami` | sign in (device flow), out, and who am I |
| `boxes` · `use <name>` | the boxes you are signed in to, and which is current |
| `status` | the box's version, herdr, the agents and their states, apps, and the system |
| `open [surface\|path]` | the box in your browser: a surface (`workbench`, `files`, `terminal`, …) or a path in Files |
| `attach [herdr options…]` · `attach --web` | herdr in this terminal: `herdr --remote <box>` when herdr is installed here, else its TUI streamed from the box |
| `shell [--cwd <dir>]` | a bash shell in the box |
| `ssh-setup [--via <host>\|--tunnel]` · `ssh [command…]` | make `ssh <box>` work here (key, pinned host key, `~/.ssh/config`), and ssh in |
| `proxy tcp:<port>` | stdin/stdout joined to a port in the box: ssh's ProxyCommand |
| `files ls\|stat\|get\|put\|rm\|mv\|cp\|mkdir\|cat\|edit` | the workspace's files |
| `mount [dir] [--no-mount]` | the workspace as a folder here (WebDAV) |
| `forward <port>[:<local>]…` | a port in the box at `localhost` here |
| `apps ls\|open\|share\|unshare\|forward` | the box's apps (`/a/<id>/`): list, open, share (`--expires 7d`, `--passcode`, `--set-passcode`), make private, forward to localhost |
| `agents ls` · `review ls\|open` | the agents at work, and pages awaiting your review |
| `herdr add` | the box as a saved machine in herdr here (`herdr machine add <box>`) |
| `herdr call <method> [json]` · `herdr socket [path]` | raw herdr RPC, and a local Unix socket that speaks to the box's herdr (not on Windows) |
| `update` | the CLI your box serves, in place of this one |

`agentbox <command> --help` has the details.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | done |
| 1 | the box refused, or something else went wrong |
| 2 | usage: an unknown command, a bad option, the wrong number of arguments |
| 3 | not signed in, or the box no longer accepts this device's token |
| 4 | not found: no such file, box or path |
| 5 | the box could not be reached (DNS, TCP, TLS, a timeout) |
| 130 | interrupted (Ctrl-C) |

`attach` and `shell` exit with the remote program: 0 when it exited cleanly
or you detached, 1 otherwise.

## Terminals: attach and shell

`agentbox attach` is the same herdr session as `/terminal` in the browser and
the Workbench — every workspace, pane and agent — in your local terminal. It
works one of two ways.

**With herdr installed here** (the CLI offers to run herdr's installer,
`curl -fsSL https://herdr.dev/install.sh | sh`, the first time), it runs
`herdr --remote <box>` over SSH, setting SSH up first if it is not. Your
herdr draws the UI — sidebar, menus, theme, your keybindings — and the box's
herdr sends only what the panes show, compressed, reconnecting on its own
after a dropped network or a sleep. It is much faster than the streamed TUI
and has none of its redraw glitches. Anything after `attach` goes to herdr
(`agentbox attach --session work`), and herdr's own keys detach
(**Ctrl-b q** by default). `agentbox herdr add` instead saves the box as a
machine in herdr (`herdr machine add <box>`), so its agents sit beside this
machine's in one window, and `herdr --machine <box> agent list` scripts it.

**Otherwise** (or with `--web`), herdr's whole TUI runs on the box and its
screen is streamed here through the gate, as `/terminal` does in a browser.
**Ctrl-] then q** detaches and leaves everything running; Ctrl-] twice sends
one Ctrl-]. It
works however your terminal sends the keys — the classic bytes, kitty's
keyboard protocol (kitty, WezTerm, foot, Ghostty, once herdr turns it on) or
xterm's modifyOtherKeys. Quitting herdr ends the command.

`agentbox shell` is a login bash, as `/shell` in the browser. `--cwd <dir>`
starts it somewhere else (it types a `cd` first). `exit` or Ctrl-] q leaves.

Both speak ttyd's own WebSocket protocol through the gate, with your device
token. The terminal runs raw, follows your window size, and asks the box to
pause when it cannot keep up with the output. If the box stops answering
(a laptop that slept, a network that changed), the CLI notices within about a
minute of missed keepalives and says so instead of hanging. Whichever way the session ends
— detaching, the program exiting, a dropped connection, a signal — your
terminal is put back: raw mode off, and every mode the remote program switched
on (the alternate screen, mouse reporting, bracketed paste, a hidden cursor,
line wrap and the like) switched back, so a TUI cut off mid-draw does not
leave your terminal unusable. Keepalive pings every 25 s stop Cloudflare
dropping a quiet session.

Without a terminal (stdin piped), both still work: keystrokes are what you
pipe in, and the size is `$COLUMNS`×`$LINES` or 80×24.

### Mouse and clipboard

| | `herdr --remote` (herdr here) | streamed TUI (`--web`, no herdr here) |
| --- | --- | --- |
| Clicks and scrolling in herdr (sidebar, tabs, panes) | yes, handled by your herdr | yes, passed through to the box's herdr |
| Mouse in a TUI in a pane (Claude Code, vim, htop) | yes | yes |
| A pane copies (OSC 52) → your clipboard | yes | yes |
| Paste text | yes (bracketed) | yes (bracketed) |
| Paste an image | yes: herdr puts it in a temp file on the box and pastes the path | no |

A copy reaches your clipboard as OSC 52, so your terminal must allow OSC 52
writes (kitty, WezTerm, Ghostty, foot, Windows Terminal do; iTerm2 has a
setting; inside tmux, `set -g set-clipboard on`). The end-to-end tests check,
on both paths, that a click reaches a mouse-reporting program in a pane and
that a pane's copy reaches your terminal.

## SSH: the box as a host

`agentbox ssh-setup` (which `login` runs) makes `ssh <box>` work, using the
box's name here:

- a key: `~/.ssh/id_ed25519` if you have one, else a new
  `~/.ssh/agentbox_ed25519`;
- that key added once to the box's `~/.ssh/authorized_keys` (0600), through
  the files API;
- the box's host key, fetched the same way and pinned in
  `~/.ssh/agentbox_known_hosts` under `agentbox-<box>`;
- a marked block at the top of `~/.ssh/config` (edits inside it are
  replaced; everything outside is left alone):

  ```text
  # >>> agentbox: work (managed by `agentbox ssh-setup`; edits inside are replaced)
  Host work
    User coder
    ProxyCommand /home/you/.local/bin/agentbox proxy tcp:2222 --box work
    HostKeyAlias agentbox-work
    UserKnownHostsFile /home/you/.ssh/agentbox_known_hosts
    StrictHostKeyChecking yes
    IdentityFile /home/you/.ssh/id_ed25519
    IdentitiesOnly yes
  # <<< agentbox: work
  ```

It prints what it changed, and running it again changes nothing. `agentbox
logout` undoes it — the key comes off the box before the token is revoked,
and the block and the pinned host key go here (the key files stay) — unless
you pass `--keep-ssh`. Run it again
if you move the CLI. The ProxyCommand is `agentbox proxy`: ssh's bytes through
the gate's tunnel, with this device's token, to the box's sshd, which listens
on the sandbox's loopback only. See [security.md](security.md#ssh) for the
two locks.

Then anything that speaks OpenSSH works:

```bash
ssh work                                  # a shell (agentbox ssh does the same)
agentbox ssh 'cd /workspace && git status'
rsync -a ./data/ work:/workspace/data/    # scp and sftp too
```

- **VS Code / Cursor**: Remote-SSH → *Connect to Host…* → `work`, then open
  `/workspace`. It forwards a port to its server in the box, which the box's
  sshd allows (to the sandbox's own loopback, nothing else).
- **Zed**: `zed ssh://work/workspace`, or *Open Remote* → `work`.
- **herdr**: `agentbox attach` and `agentbox herdr add`, above.

### The fast path: through the box's host

If you can already `ssh` to the machine the box runs on (say a `vps` entry in
`~/.ssh/config`, as its operator), and run `docker` there:

```bash
agentbox ssh-setup --via vps        # or: agentbox login <url> --via vps
```

The ProxyCommand becomes `ssh vps` then `docker exec -i <the box's ssh
container> agentbox-sshd -i`: the box's sshd speaks over that exec's stdin and
stdout. It skips Cloudflare and the HTTPS tunnel (lower latency), and needs no
port for the box on any network: one SSH port on the host serves every box on
it. ssh-setup finds the box's compose project on the host by its host key, and
the ProxyCommand looks the container up by its compose labels at every
connect, so a recreated container is found again. `agentbox ssh-setup
--tunnel` goes back to the HTTPS tunnel. It leans on your access to the host,
not on this device's token: anyone who can run docker on the host owns the box
anyway.

## Files

Paths are the box's: absolute, relative to `/workspace`, or `~/…` for home —
quote a `~` path (`'~/notes'`), or your own shell expands it first.

```bash
agentbox files ls                      # /workspace (-a: hidden files too)
agentbox files put ./data -r           # into /workspace/data
agentbox files put build.zip proj/     # into proj (a trailing / makes the folder)
agentbox files get proj/out -r .       # the folder, into the current one
agentbox files get notes.md -          # to stdout
agentbox files cat proj/README.md
agentbox files mv old.txt archive/     # into a folder, or to a new name
agentbox files cp -r proj proj-copy
agentbox files rm -r scratch           # to the box's trash
agentbox files mkdir a/b/c
agentbox files edit proj/.env          # in $VISUAL or $EDITOR
```

- **Uploads** go in chunks of at most 50 MiB (under Cloudflare's 100 MB
  request limit); `--chunk-size` lowers it for a proxy with a smaller one. A
  chunk that fails on the network or with a 5xx is retried from what the box
  says it has. If an upload is cut off — Ctrl-C, a dropped connection, a
  closed laptop — **run the same command again**: it resumes where the box
  left off (the box keeps an untouched upload for a day).
- **Downloads** land under a temporary name and are renamed into place only
  when complete. Existing local files are replaced.
- **Nothing is deleted outright.** `rm` moves things to the box's trash
  (restore them from Files → Trash in the app). `put`, `mv` and `cp` refuse to
  replace what is there unless you add `--force`, and then the old one goes to
  the trash too.
- **`edit`** downloads the file (or starts a new one), opens your editor on a
  private copy, and saves it back when the editor exits with changes. If the
  file changed on the box while you were editing, nothing is overwritten: the
  CLI keeps your copy and says how to save it anyway. Ctrl-C while the editor
  runs is the editor's, as with git. A link is edited through: the file it
  points at is saved, and the link stays a link.
- `-r` is needed for folders in `get`, `put`, `cp` and `rm`.
- **Links in a folder you `put -r`**: a link to a file inside the folder goes
  up as that file. A link to a folder, or any link that leads out of the
  folder — a `secrets -> ~/.ssh` in a project — is skipped, and the CLI says
  which. `-L` (`--follow`) follows them all.
- Names are shown with control characters escaped, so a file name cannot send
  commands to your terminal. A name that is not valid UTF-8 can be listed,
  fetched and removed; downloaded, it gets a replacement character.

## Mount

```bash
agentbox mount              # macOS: ~/agentbox/<box>; Linux: gvfs; Windows: a free drive
agentbox mount ~/box        # there (Linux: a link to gvfs's folder)
agentbox mount --no-mount   # just serve it, and print the URL, user and password
```

The workspace becomes a folder in Finder, your file manager or Explorer. Keep
the command running while you use it; Ctrl-C unmounts.

Your operating system's WebDAV client cannot carry a device token, so the CLI
serves the box's WebDAV (`/api/dav/`) on this machine, adds the token to what
it forwards, and mounts that with what the system has:

| System | Mounted with | Where |
| --- | --- | --- |
| macOS | `mount_webdav` | `[dir]`, default `~/agentbox/<box>` |
| Linux | `gio mount` (gvfs, with its WebDAV backend) | gvfs's own folder; `[dir]` becomes a link to it |
| Windows | `net use` (the WebClient service) | the drive letter `[dir]`, default the next free one |

When the helper is missing it says so and how to install it — on Debian or
Ubuntu, `sudo apt install gvfs-backends libglib2.0-bin`. On Linux the folder
is gvfs's FUSE view (under `$XDG_RUNTIME_DIR/gvfs/`), which a desktop session
runs; without it (a server, a container) the mount is still there for GIO
applications such as Files, at the `dav://` address the command prints.
`--no-mount` works anywhere: point any WebDAV client at the URL it prints and
sign in with the user and password it prints (`rclone`:
`:webdav,url=<url>,vendor=other,user=agentbox,pass=<rclone obscure password>:`;
`cadaver`; a file manager's "connect to server"). `--port` picks the local
port.

### What guards the mount

Anyone who can talk to the local server reaches the box as this device, so it
is guarded, while it runs, by:

- **Loopback only.** It listens on `127.0.0.1`, and answers only a `Host` that
  is loopback, so a web page cannot reach it by DNS rebinding.
- **A secret path.** Nothing is answered outside a random 128-bit path. That
  path is not a password: it appears in the helper's command line (`ps`), in
  the mount table (`mount` on macOS), and in the name of gvfs's folder.
- **A password.** Every request must carry HTTP Basic credentials: the user
  `agentbox` and a random 192-bit password made for this run. The helper gets
  it outside any command line — `mount_webdav` reads it from a file descriptor
  (`-a`, from a file that has no name on disk), `gio mount` from its standard
  input — and `--no-mount` prints it for you. So another user of this
  machine who learns the address still cannot use it.
- **On Windows, the secret path alone.** Windows' WebClient sends Basic
  credentials only over https, so a `net use` mount is served without a
  password. Another user of the same Windows machine who can read your
  processes' command lines, or guess the path, could use it while it runs; on
  a shared Windows machine, prefer `agentbox files`. (`--no-mount` on Windows
  still asks for the password.)
- **The Linux link** names the secret path in its target, which anyone who
  can list its folder can read; the password above is what that leaves them
  short of.

The token itself never leaves the CLI: the OS's client sees only the local
server. Nothing that could climb out of `/api/dav/` (dot segments, encoded or
not, slashes, NUL) is forwarded. A request may take as long as it needs — a
large copy over a slow link is not cut off after five minutes.

Deleting sends things to the box's trash. Finder litters network folders with
`._*` and `.DS_Store` files; those are deleted for good rather than trashed,
and `defaults write com.apple.desktopservices DSDontWriteNetworkStores true`
stops them. Windows' WebClient refuses files over 50 MB unless
`FileSizeLimitInBytes` is raised; use `agentbox files` for large files there.

## Forward

```bash
agentbox forward 5173           # the box's port 5173 at http://localhost:5173
agentbox forward 5173:3000 8080 # remote 5173 at local 3000, and 8080 as 8080
```

Each connection to the local port gets its own WebSocket tunnel through the
gate to that port in the box, so a dev server works at full fidelity — its own
origin, cookies, service workers and HMR. `apps forward <app> [local]` does the
same for an app by name; `herdr socket` puts the box's herdr at a local Unix
socket (`HERDR_SOCKET_PATH=<it> herdr`), private to you.

The local port listens on `127.0.0.1` only, but there it is the box's port
with no sign-in in front: while `forward` runs, anyone on this machine can use
it, and so can a web page, by DNS rebinding, when the service does not check
its `Host`. Forwarding one of agentbox's own services (the editor on 8080, the
terminals on 7681–7683, sshd on 2222, the bridge on 7800/7801, the gate on 7900/7901) hands
out that service as this device, and the CLI warns before it does.

## Troubleshooting

**"the box did not accept this device's sign-in"** (exit 3). The token was
revoked — in Settings → Devices, or by `./scripts/agentbox gate revoke-all`
on the host — or the gate's store was replaced. `agentbox login <url>` again.

**"could not reach …"** (exit 5). The box is down, the name does not resolve
from here, or its certificate is not valid. `curl -I https://<box>/login`
tells the same story.

**The terminal is garbled after a crash.** The CLI restores it on every way
out it can see, but `kill -9` leaves no chance: run `reset`.

**An upload will not resume.** An upload the box has not seen for a day is
swept; a changed local file, or adding `--force`, starts a new one. Either
way the command starts over by itself.

**Cloudflare Access in front of the box.** Access answers the CLI's requests
with its own login page. Give the hostname a bypass or service-token policy
for the CLI, or use agentbox's own sign-in alone.
