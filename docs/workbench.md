# The Workbench

The Workbench is a browser client for [herdr](https://github.com/herdrdev/herdr),
the agent multiplexer that runs inside the sandbox. The app it belongs to is
served at the root of your box, behind the same sign-in as everything else, and
the Workbench is its `/workbench` route. Links from before the app moved to the
root — `/workbench/…`, including old review links — redirect there.

The editor at `/vscode/` is where you read and write code. The TUI at `/terminal` is
where you drive agents from a keyboard on a small screen. The Workbench is the
surface in between: several agents across several workspaces, all visible at
once, each in a live terminal, with the web apps they build previewable beside
them. herdr owns the session — the panes, the layouts, the agent processes —
so closing the tab detaches rather than kills, and the TUI and the Workbench
are two views of one session rather than two sessions.

![The Workbench in light mode](images/workbench-light.png)

Everything it shows comes from herdr over a local socket. The bridge that
serves the app holds one connection to herdr and fans its events out to every
open tab, so two browsers, a phone and the TUI all stay in step. Nothing is
stored in the browser except your theme, the sidebar's width and the
inspector's own shape — whether it is open, which tab it shows and how wide it
is.

![The Workbench in dark mode](images/workbench-dark.png)

## The layout

- **Sidebar** — workspaces, their tabs, and a flat list of every agent with its
  status. A workspace rolls up the worst status inside it, so a blocked agent
  is visible without expanding anything. `prefix+b` or `⌘B` hides it, and the
  edge between it and the grid can be dragged to resize it.
- **Tab bar** — the tabs of the focused workspace. Rename in place with `F2`,
  close with `Delete`, walk them with the arrow keys.
- **Pane grid** — herdr's layout, rendered as live terminals. Drag a split to
  resize it; the new ratio is sent to herdr, which is authoritative, so every
  other viewer follows.
- **Composer** — appears under the grid when the focused pane holds an agent.
  `Enter` sends, `Shift+Enter` starts a new line, and `Escape` puts focus back
  in the terminal.
- **Inspector** — a column on the right with two panels: **Preview** for the
  ports something is listening on, and **Review** for the pages agents publish
  for you to comment on.

## Working with agents

Create a workspace from the palette (`⌘/Ctrl+K` → *New workspace*) or with
`prefix+⇧N`. The picker is confined to `/workspace`; tick *Create a git
worktree* to branch an existing repository into a workspace of its own, which
is the usual way to put two agents on the same codebase without them fighting
over the index.

Then run an agent in a pane like you would anywhere else:

```bash
claude          # or codex
```

herdr notices the agent and the Workbench starts tracking it: its status
appears beside the pane title, in the tab, in the workspace rollup and in the
agent list. When an agent blocks on a question in a pane you are not looking
at, a toast appears and the document title picks up a count, so a background
tab still tells you. *Next blocked agent* in the palette jumps to the one
waiting longest.

Closing a pane, a tab or a workspace that still has a working agent asks first.

## Keyboard

The prefix is `Ctrl+B`, as in herdr's TUI and tmux. Press it, see the HUD pill,
then press the binding. It works inside a terminal and outside one; only a text
field takes precedence.

| Keys | Action |
| --- | --- |
| `⌘/Ctrl+K` | command palette |
| `prefix+c` | new tab |
| `prefix+v` / `prefix+-` | split right / split down |
| `prefix+h` `j` `k` `l` | focus the pane left / down / up / right |
| `prefix+⇧H` `⇧J` `⇧K` `⇧L` | swap the pane in that direction |
| `prefix+z` | zoom the focused pane |
| `prefix+x` / `prefix+⇧X` | close pane / close tab |
| `prefix+n` / `prefix+p` / `prefix+1…9` | next / previous / nth tab |
| `prefix+⇧N` / `prefix+⇧W` / `prefix+⇧D` | workspace: new / rename / close |
| `prefix+w` / `prefix+g` | palette, filtered to workspaces / everything |
| `prefix+b` or `⌘B` | toggle the sidebar |
| `prefix+q` | blur the terminal (the browser's equivalent of detach) |
| `prefix+Ctrl+B` | send a literal `Ctrl+B` to the program in the pane |
| `prefix+?` | show this keymap |

## Previews

The bridge watches which TCP ports are listening inside the sandbox and lists
them in the Preview panel, hiding agentbox's own services behind a toggle. Pick
one and it loads in the panel, with device widths and an editable path.

Before it mounts the frame the panel probes the port and shows a calm state —
checking, or "nothing is serving on port N yet" with a Retry — so the common
case of a dev server that has not finished starting is a message rather than a
flash of an error page. If a page load does reach a port where nothing is
answering — refused, or silent for 90 seconds before starting a response — the
bridge returns its own branded page with a Retry instead of letting Cloudflare
or the browser render a raw 502. A script's request gets a plain `502` it can
handle, and anything the app itself sends, error statuses included, comes
through untouched, so a framework's error overlay or a deliberate `503` still
shows. Once a response has started there is no timeout, so server-sent events
and long downloads are left alone.

The bridge proxies `/preview/<port>/…` to `127.0.0.1:<port>` inside the
sandbox. Because that is the Workbench's own origin, the iframe is sandboxed
*without* `allow-same-origin`: an agent-written dev server must not be able to
script the Workbench, read its storage or call its API as you. Four things
follow.

The previewed page has no `localStorage` and no same-origin requests of its
own — that much is the sandbox, and it applies inside the panel only.

Inside the panel it loads its page but not its stylesheets, scripts or images.
A sandboxed frame's requests count as cross-site, and the sign-in cookie is
deliberately not sent on cross-site requests, so the gate refuses them. Open the
preview full screen (below) to see the whole app.

It has no cookies either, and that is not the sandbox: the bridge strips
`Cookie` (and `Authorization`) from everything it forwards, so your sign-in for
the box is never handed to a port an agent opened. That holds in the
full-screen window too, so a previewed app with its own cookie login will not
work through a path preview at all.

Its websockets are refused as well: a sandboxed document has no origin of its
own — it sends `Origin: null` — and the bridge accepts an upgrade only from its
own origin, so live reload does not connect in this mode. Page loads and
reloads are unaffected.

Apps that build absolute URLs from the origin, or that are mounted at the root,
may also need to be told they are behind a prefix — Vite's `base`, Next's
`basePath`, JupyterLab's `--ServerApp.base_url`, and similar.

Full-screen (the ↗ button) opens the preview as a page of its own. It asks
first: a top-level window has no sandbox attribute, so the agent's page would
get the Workbench's own origin — its storage, its API and its terminals.

Per-port preview hostnames (`PORT.<preview-domain>`) were removed: the sign-in
cookie is host-only, so it never reaches another hostname.

### Sharing a preview

Public sharing is off. The old `/s/<token>/` links opened without a sign-in on
the strength of a record the bridge kept inside the sandbox, where an agent
could have written one; the gate, which decides who gets in, admits no one
without a session. The Share action is hidden, and sharing returns as app
sharing decided by the gate. See [the security model](security.md#the-front-door).

## Review

Some of what an agent has to say is a place in a document rather than a
paragraph: a plan you want reordered, a table with one wrong row, a diagram
missing an arrow. Review is that conversation. The agent writes an HTML file
and publishes it; you see it in the drawer, click the heading or select the
phrase you mean, say what you think, and send. The agent's command was blocked
all along and returns with your comments attached to what they refer to.

From inside the sandbox:

```bash
agentbox-review open plan.html --label "Rollout plan"
agentbox-review poll plan.html          # blocks until you press Send
```

`open` prints a link — `<your box>/workbench?review=<key>` — and the session
appears in the **Review** panel of the inspector. The CLI talks to the bridge
at `http://127.0.0.1:7800` inside the sandbox (`AGENTBOX_REVIEW_URL` overrides
it). Choose it and the page renders there, beside the terminals — no
second hostname and no second login, which is what the old lavish-axi service
could never offer.

Press **Annotate**, then click an element or select some text: it becomes a
comment with that anchor, and you write your note against it. Clicking an
anchor afterwards scrolls the page back to it. The free-form box at the bottom
is for anything about the whole thing. **Send** hands everything over and the
agent carries on; **Send & end** does the same and closes the session, which
is how you say you are finished with it.

Agents find this for themselves: the image installs a Claude Code skill at
`~/.claude/skills/review/`, so an agent that is about to describe something
visual reaches for the command without being told. `agentbox-review --help`
is the same information for any other agent.

The page an agent writes is not trusted. It is served with
`Content-Security-Policy: sandbox allow-scripts`, so it runs with an opaque
origin — no cookies, no storage, no same-origin access to the Workbench — and
the iframe repeats that with a `sandbox` attribute of its own. The only thing
crossing the boundary is the anchor you picked. This is why full screen (the ↗
button) needs no warning here, unlike a preview: the header travels with the
response, so the page is just as sandboxed in a tab of its own. Inline your
CSS in artifacts, though: an external stylesheet or font cannot load.

Sessions live under `~/.agentbox/review/` on the home volume, so they survive a
restart or an update, and `agentbox-review list` shows what is outstanding.

## The bridge's API

The bridge that serves the app also serves everything the app's surfaces
read and change. The app is at `/`, its API under `/api/*`, and its sockets
under `/ws/*`; every path the app owns (`/workbench`, `/files/…`,
`/settings/…`) is answered with the app itself, so a deep link survives a
reload. Inside the sandbox the same bridge is `http://127.0.0.1:7800`, which
is what `agentbox-review` talks to.

### Files

`/api/files/*` serves two roots: the workspace (`/workspace`) and home
(`/home/coder`, hidden in the app by default). Every path is absolute; a
relative one is taken against the workspace, and `~/…` against home. Each
path is resolved on disk and must stay inside its root: a symlink that leads
out can be listed, renamed and trashed as a link, but nothing is ever read or
written through it.

| Endpoint | What it does |
| --- | --- |
| `GET list?path=&hidden=&offset=&limit=` | a directory, folders first, with size, mtime, symlink target and git status; at most 5000 entries a page, with `truncated` |
| `GET stat?path=` | one entry |
| `GET raw?path=&inline=` | the file; ranges supported |
| `GET zip?path=…&path=…` | a zip of one or more paths, streamed as it is built |
| `POST uploads {path, size, overwrite}` → `{uploadId}` | start a chunked upload |
| `PUT uploads/:id?offset=` | one chunk of at most 50 MiB |
| `POST uploads/:id/finish` | move the finished file into place |
| `GET` / `DELETE uploads/:id` | progress, or cancel |
| `POST write {path, content, overwrite?}` | a small text file (up to 1 MiB) |
| `POST mkdir {path}` · `move {from, to, overwrite?}` · `copy {from, to, overwrite?}` | folders, renames and copies |
| `POST trash {paths}` · `GET trash` · `POST trash/:id/restore {to?}` · `DELETE trash/:id` · `DELETE trash` | the trash |
| `GET search?q=&path=&limit=` | file names, for the palette (`fd` when present) |

Nothing is deleted outright except from the trash. What happens to a file
that is replaced depends on whether the operation is a delete or a save:

| Operation | What it replaces goes |
| --- | --- |
| trash, WebDAV `DELETE` | to the trash |
| move or copy with `overwrite`, WebDAV `COPY`/`MOVE` over an existing name | to the trash |
| upload with `overwrite` | to the trash |
| `write` with `overwrite`, WebDAV `PUT` over a file | nowhere: it is a save, replaced in place in one step, as an editor would |

A file replaced in place or by an upload keeps its mode, so a script stays
executable. The trash and upload scratch space live in `.agentbox/` at the top
of each root, so moving something in or out is a rename on the same volume;
that folder can be neither copied nor moved. Uploads nobody has touched for a
day are swept.

Everything is safe to repeat, because networks drop answers: a chunk can be
resent at any offset up to what has arrived (a chunk further on is refused
with the offset to resume from), finishing twice answers the same, and a
second trash of the same path reports it as already gone.

Downloads carry `Content-Security-Policy: sandbox` and `nosniff`, and no file
can be loaded as a script, worker or stylesheet (those requests get a 403, and
scripts are labelled `text/plain` besides). `inline` shows pictures, PDF and
text in the browser; HTML and SVG are only ever shown as their source text,
never rendered on the box's origin. PDFs keep the sandbox: Chromium's and
Firefox's built-in viewers both work under it, at the top level and in a
frame — but Chromium refuses a PDF in a frame that has a `sandbox` attribute,
so frame the raw URL without one (the header already isolates it).

A zip streams as the folder is read and stops if the download is abandoned; a
`HEAD` builds nothing. Folder listings are read and sorted once and kept for a
few seconds, so paging through a big folder does not re-read it for every
page.

Linux filenames are bytes, not text. A name that is not valid UTF-8 travels
with each stray byte as a lone surrogate (U+DC80 + byte), so it can be listed,
renamed, downloaded and deleted like any other; send its `path` back exactly
as received. In a zip such names show a replacement character, a name that
looks like a drive letter (`C:notes.txt`) gets an underscore, and names made
alike that way get a ` (2)` suffix.

### WebDAV

`/api/dav/` serves the workspace over WebDAV, which is what `agentbox mount`
puts in Finder, the GNOME file manager (`gio mount`) or `rclone`. It is the
same files API underneath — the same confinement, and deleting sends things to
the trash — with these differences. Symlinks inside the workspace appear as
what they point at; links that lead out do not appear at all, and neither do
links that lead back to a folder above or on the way (`proj/up -> ..`), which
every client that walks a mount would otherwise follow for ever. The
`.agentbox/` folder is not part of the mount. Custom ("dead") WebDAV
properties are not stored; clients that only read and write files never
notice, and Windows' timestamps are applied as modification times. Locks are
held in memory, at most a thousand at once.

macOS writes `._` files and `.DS_Store` beside everything on a network volume,
and Windows `Thumbs.db` and `desktop.ini`; deleting a file by exactly one of
those names removes it for good rather than filling the trash (a folder by
such a name still goes to the trash). To stop Finder writing `.DS_Store` files
there at all:
`defaults write com.apple.desktopservices DSDontWriteNetworkStores true`.

### System, projects and the editor

- `GET /api/system` — how the sandbox is doing, in two views. The sandbox is
  several containers (editor, terminals, monitor, Workbench) sharing one
  process table, each with its own limits, so `sandbox` sums CPU and resident
  memory over every process, and `container` is the Workbench container's own
  cgroup — its use and its limits, and where the agents it starts run. Also
  free space on both volumes, uptime, the fifteen busiest processes, and the
  versions of agentbox, herdr, code-server and each agent CLI on `PATH`.
- `GET /api/projects` — a card per top-level folder of the workspace: git
  branch, uncommitted changes, ahead/behind, last change, the panes working in
  it and the servers it runs. `POST /api/projects {name}` makes an empty one;
  `POST /api/projects/clone {url, name?}` clones one (https, ssh, git or
  `user@host:path` URLs), with progress on the events socket as
  `project.clone`; `DELETE /api/projects/clone/:id` cancels it, and a clone
  gives up after ten minutes. Credentials in the URL are never repeated in
  events or messages.
- `POST /api/editor/open {path, line?, column?, wait?}` opens a file in the
  editor, at the line, and answers `{delivered}`. The editor is joined to the
  bridge by the **agentbox connect** extension baked into the image, over
  `/ws/editor` — a socket the bridge accepts only from inside the sandbox.

## firstmate

[firstmate](https://github.com/herdrdev/firstmate) drives a fleet of agents
across git worktrees. It fits a workspace well:

```bash
cd /workspace
git clone https://github.com/you/your-project
cd your-project
gh auth login            # gh is in the image; firstmate uses it for PRs
firstmate                # or: firstmate --backend herdr
```

With the tmux backend it manages its own session inside the pane. With the
herdr backend its panes become herdr panes, which means they show up as
workspaces and agents in the Workbench like anything else. Either way, create
the workspace as a **git worktree** first if you want the Workbench's own
worktree bookkeeping rather than firstmate's.

## Troubleshooting

**The connection pill says disconnected.** The bridge could not reach herdr.
`./scripts/agentbox workbench` shows its log; it starts a herdr server itself
if none is answering and retries with backoff, so this usually clears on its
own. If it does not, `./scripts/agentbox shell` and run `herdr` to see whether
the server is healthy.

**A terminal shows "Disconnected".** The websocket dropped — a restarted
bridge, a tunnel blip. It retries with backoff and repaints from herdr's own
buffer when it returns, so nothing is lost. After several failures it stops and
offers a Reconnect button.

**A pane is blank.** The pane exists but the program in it has drawn nothing
yet. Click it and press a key.

**The port is not listed.** The Workbench only lists ports bound inside the
sandbox. A server bound to `127.0.0.1` is fine — that is the common case — but
one started on the host is invisible, by design. Ports belonging to agentbox's
own services are hidden behind *Show system*.

**The page went back to sign in.** The session ended: 12 hours unused (unless
"Remember this device" was ticked), a password or two-factor change, or a
sign-out elsewhere. The Workbench notices on its next request, or when the tab
comes back into view, and returns you where you were after signing in.

**Cloudflare Access in front of the tunnel.** Access intercepts the websocket
upgrade for anything without a session, so the Workbench's event stream and its
terminals will not connect from an unauthenticated context. Add a service-token
or bypass policy for the hostname, or use agentbox's own sign-in alone.
