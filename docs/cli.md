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

On Windows, where there is no `sh`, download `https://<box>/cli/agentbox.mjs`
and run it with `node agentbox.mjs …`. From a checkout: `cd web && npm ci &&
npm run build -w cli && npm i -g ./cli`.

`agentbox update` replaces the CLI with the build your box serves: it
downloads `/cli/agentbox.mjs`, checks that it is an agentbox build and that it
starts, and swaps it in with one rename. Once a day the CLI asks the box which
version it runs (`/_gate/version`) and says so when they differ.

## Sign in

```bash
agentbox login https://work.example.com
```

The CLI shows a code and opens your box's `/settings/devices?code=…` page (or
prints it, over ssh or with `--no-browser`). Sign in there if you are not
already, check the code matches, enter your password and approve. The CLI
never sees your password: it collects a **device token** of its own, which
Settings → Devices lists and can revoke.

- `--name <name>` — what to call the box here (default: its first DNS label,
  e.g. `work`).
- `--device <label>` — how the box lists this device (default: `agentbox CLI
  on <hostname>`).

`agentbox logout` revokes the token at the box and forgets it here. If the box
cannot be reached, `logout --local` forgets it anyway; revoke it in Settings
→ Devices. Signing in to the same box again revokes the token it replaces.

`agentbox whoami` says who and where you are signed in.

### Several boxes

Every box you sign in to is kept by name, and one is current.

```bash
agentbox boxes              # the list; * marks the current one
agentbox use home           # make "home" current
agentbox --box home status  # one command against another box
```

`$AGENTBOX_BOX` does what `--box` does.

### Where the token is kept

In `~/.config/agentbox/config.json` (or `$XDG_CONFIG_HOME/agentbox/`), and
nowhere else: the file is created readable by you alone (`0600`, in a `0700`
folder), and if it is ever found open to others the CLI closes it again and
says so. The token is never printed, `--json` included. Treat the file like an
ssh key: anyone who reads it has your box until you revoke the device.

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
| `attach` | herdr's TUI in this terminal |
| `shell [--cwd <dir>]` | a bash shell in the box |
| `files ls\|stat\|get\|put\|rm\|mv\|cp\|mkdir\|cat\|edit` | the workspace's files |
| `mount [dir] [--no-mount]` | the workspace as a folder here (WebDAV) |
| `forward <port>[:<local>]…` | a port in the box at `localhost` here (needs a box with tunnels) |
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

`agentbox attach` is the same herdr session as `/terminal` in the browser —
every workspace, pane and agent — in your local terminal. **Ctrl-] then q**
detaches and leaves everything running; Ctrl-] twice sends one Ctrl-]. Quitting
herdr ends the command.

`agentbox shell` is a login bash, as `/shell` in the browser. `--cwd <dir>`
starts it somewhere else (it types a `cd` first). `exit` or Ctrl-] q leaves.

Both speak ttyd's own WebSocket protocol through the gate, with your device
token. The terminal runs raw, follows your window size, and asks the box to
pause when it cannot keep up with the output. Whichever way the session ends
— detaching, the program exiting, a dropped connection, a signal — your
terminal is put back: raw mode off, and every mode the remote program switched
on (the alternate screen, mouse reporting, bracketed paste, a hidden cursor,
line wrap and the like) switched back, so a TUI cut off mid-draw does not
leave your terminal unusable. Keepalive pings every 25 s stop Cloudflare
dropping a quiet session.

Without a terminal (stdin piped), both still work: keystrokes are what you
pipe in, and the size is `$COLUMNS`×`$LINES` or 80×24.

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
  CLI keeps your copy and says how to save it anyway.
- `-r` is needed for folders in `get`, `put`, `cp` and `rm`.
- Names are shown with control characters escaped, so a file name cannot send
  commands to your terminal. A name that is not valid UTF-8 can be listed,
  fetched and removed; downloaded, it gets a replacement character.

## Mount

```bash
agentbox mount              # macOS: ~/agentbox/<box>; Linux: gvfs; Windows: a free drive
agentbox mount ~/box        # there (Linux: a link to gvfs's folder)
agentbox mount --no-mount   # just serve it, and print the URL
```

The workspace becomes a folder in Finder, your file manager or Explorer. Keep
the command running while you use it; Ctrl-C unmounts.

Your operating system's WebDAV client cannot carry a device token, so the CLI
serves the box's WebDAV (`/api/dav/`) on `127.0.0.1` behind a random 128-bit
path, adds the token itself, and mounts that with what the system has:

| System | Mounted with | Where |
| --- | --- | --- |
| macOS | `mount_webdav` | `[dir]`, default `~/agentbox/<box>` |
| Linux | `gio mount` (gvfs, with its WebDAV backend) | gvfs's own folder; `[dir]` becomes a link to it |
| Windows | `net use` (the WebClient service) | the drive letter `[dir]`, default the next free one |

When the helper is missing it says so and how to install it — on Debian or
Ubuntu, `sudo apt install gvfs-backends libglib2.0-bin`. `--no-mount` works
anywhere: point any WebDAV client at the URL it prints (`rclone` with
`:webdav,url=<url>,vendor=other:`, `cadaver`, a file manager's "connect to
server"). `--port` picks the local port.

The local server answers only on loopback, only under its secret path, and
only to a `Host` that is loopback (so a web page cannot reach it by DNS
rebinding). It never forwards anything that could climb out of `/api/dav/`
on the way to the box. Deleting sends things to the box's trash. Finder
litters network folders with `._*` and `.DS_Store` files; those are deleted
for good rather than trashed, and
`defaults write com.apple.desktopservices DSDontWriteNetworkStores true`
stops them. Windows' WebClient refuses files over 50 MB unless
`FileSizeLimitInBytes` is raised; use `agentbox files` for large files there.

## Forward (with tunnels)

```bash
agentbox forward 5173           # the box's port 5173 at http://localhost:5173
agentbox forward 5173:3000 8080 # remote 5173 at local 3000, and 8080 as 8080
```

Each connection to the local port gets its own WebSocket tunnel through the
gate to that port in the box, so a dev server works at full fidelity — its own
origin, cookies, service workers and HMR. It needs a box whose gate has the
tunnel endpoint; an older box says so. `herdr call`, `herdr socket` and the
`apps` commands arrive with it.

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
