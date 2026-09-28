# Workbench: a browser client for herdr inside agentbox

> **Superseded in part by [2026-09-28-one-app-design.md](2026-09-28-one-app-design.md):** the Workbench is now one surface of the app at `/`, previews are apps under `/a/<id>/`, and the gate does sign-in.

> **Partly superseded.** Everything about lavish-axi below — the panel, the
> `lavish` service, its hostname and its environment variables — was replaced
> in September 2026 by Review, which agentbox owns and serves under the
> Workbench's own base path. See
> [2026-09-22-review-design.md](2026-09-22-review-design.md). The rest of this
> document still describes what is built.

Status: approved design, September 2026.

## Purpose

agentbox already gives you an editor, a shell and a process monitor in the
browser. What it lacks is the thing that makes running several coding agents
pleasant: a view of every agent at once, which one is blocked, which one is
done, and a way to jump to it and answer. The herdr TUI provides exactly that
in a terminal. Workbench provides it in the browser, on top of the same herdr
server, with two additions a terminal cannot offer: a preview panel for the web
apps your agents build, and a panel for lavish-axi review sessions.

Workbench is written from scratch. It uses herdr only through public,
documented interfaces: the JSON socket API and the `herdr terminal session`
CLI stream. No herdr code is vendored and no private protocol is spoken.

## Goals

- Manage agents the way the herdr TUI does: workspaces, tabs, split panes,
  agent state rollups (blocked, working, done, idle), jump to the pane that
  needs you, create workspaces and git worktrees, rename, close, zoom.
- Real terminals. Every pane is a live xterm.js terminal bound to the herdr
  pane, with herdr owning scrollback and persistence.
- Same keyboard model as the TUI. `ctrl+b` prefix bindings work in the browser
  with the default herdr map, plus a command palette for everything else.
- A preview panel that lists every listening port in the sandbox and shows the
  chosen one in place, with a way to open it full-screen.
- A lavish panel that lists lavish-axi review sessions and shows the chosen one
  in place.
- Light and dark themes, toggleable, following the system by default.
- Clean, deliberate interface. The `apple-design` skill governs visual and
  interaction design decisions.
- Runs inside the sandbox boundary: unprivileged, no Docker socket, no host
  mounts, authenticated by the existing proxy.

## Non-goals

- Replacing code-server or ttyd. Both stay; Workbench is a third entry point.
- Copy mode, resize mode and the keybind-help overlay from the TUI. Mouse
  selection, drag-resize and the palette cover these.
- Multi-machine (saved SSH machines) and named sessions. One server, the
  default session.
- Authentication inside Workbench. The proxy authenticates; the bridge is
  reachable only on the internal Docker network.
- Kitty graphics, plugins, custom agent view projections.

## Where it lives

```
web/                     Workbench source (one npm workspace)
  package.json           workspaces: ["bridge", "app"]
  bridge/                Node 22 + TypeScript HTTP/WebSocket bridge
  app/                   Vite + React 19 + TypeScript browser app
  Dockerfile.stage       (not a separate image; see below)
images/workspace/Dockerfile
                         gains a build stage that compiles web/ and copies the
                         result into /usr/local/lib/agentbox-workbench, plus
                         the herdr binary and lavish-axi
docker-compose.yml       gains a `workbench` service on the same image
proxy/Caddyfile.*        gain `/workbench*` and the preview/lavish hostnames
docs/workbench.md        user documentation
```

The compose build context for the sandbox image changes from
`./images/workspace` to the repository root so the Dockerfile can see `web/`.
A `.dockerignore` keeps the context small.

## Runtime topology

All sandbox services share one network namespace and one PID namespace
(`network_mode: "service:code"`, `pid: "service:code"`). This is what makes
"localhost" mean the same thing in the editor terminal, the herdr panes, the
bridge and the preview proxy, and it is what lets the bridge see listening
ports and process names. Isolation from the host is unchanged: the namespaces
are shared between sandbox containers only.

```
browser ── Caddy (basic auth) ──┬── /            → code:8080      (code-server)
                                ├── /terminal*   → :7681          (ttyd → herdr client)
                                ├── /monitor*    → :7682          (ttyd → btop)
                                ├── /workbench*  → :7800          (bridge)
                                ├── PORT.<preview-domain>  → :7800 /preview/PORT/  (opt-in)
                                └── lavish.<domain>        → :4387 (lavish-axi)

workbench service (same image, shared namespaces)
  agentbox-workbench
    ├── ensures `herdr server` is running (spawns and supervises it)
    ├── herdr JSON socket API   ~/.config/herdr/herdr.sock
    ├── herdr terminal streams  `herdr terminal session control <pane>`
    ├── serves app/dist under the base path
    ├── /ws/events, /ws/terminal
    ├── /preview/:port/*  reverse proxy to 127.0.0.1:port
    └── /api/lavish       reads lavish-axi state, links to its public URL
```

The herdr server's socket lives on the `agentbox_home` volume, so the `herdr`
client that ttyd runs at `/terminal` attaches to the same server. Workbench and
the TUI are two clients of one session, which is herdr's own model.

## The bridge

Node 22, TypeScript, Fastify with `@fastify/websocket`, `@fastify/static` and
`@fastify/http-proxy`. Runs as UID 1000. Configuration by environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKBENCH_PORT` | `7800` | listen port, bound to `0.0.0.0` (internal network only) |
| `WORKBENCH_BASE_PATH` | `/workbench` | path prefix every route and asset is served under |
| `WORKBENCH_STATIC_DIR` | `../app/dist` | built app |
| `HERDR_SOCKET_PATH` | herdr's default | JSON API socket |
| `WORKBENCH_WORKSPACE_ROOT` | `/workspace` | root offered by the directory picker |
| `WORKBENCH_PREVIEW_DOMAIN` | unset | when set, "open full screen" uses `https://PORT.<domain>` |
| `WORKBENCH_LAVISH_URL` | unset | public origin of lavish-axi, e.g. `https://lavish.code.example.com` |
| `LAVISH_AXI_STATE_DIR` | `~/.lavish-axi` | where lavish keeps `state.json` |

### herdr connection

- On start, connect to the socket. If the connection fails, spawn
  `herdr server` as a child, wait for the socket, and supervise it (restart
  with backoff if it exits). If the socket is already answering, do not spawn.
- Keep one long-lived connection subscribed to lifecycle events:
  `workspace.*`, `worktree.*`, `tab.*`, `pane.created|closed|updated|focused|
  moved|exited|agent_detected`, `layout.updated`.
- Keep a second connection subscribed to `pane.agent_status_changed` for every
  known pane (herdr requires `pane_id` for this subscription). Re-subscribe
  whenever the pane set changes.
- Request/response calls use short-lived connections: one newline-delimited
  JSON request, one response line. The socket API is not multiplexed per
  connection, so this is the simplest correct approach.
- Bootstrap order matters and is documented by herdr: open the subscriptions,
  wait for `subscription_started`, then call `session.snapshot`. Clients that
  connect later get the snapshot the bridge holds plus every event since.
- If the herdr connection drops, the bridge reconnects, resubscribes, takes a
  fresh snapshot, and tells every browser client to reset.

### HTTP and WebSocket surface

All paths are relative to the base path.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | `{ ok, herdr: { connected, version, protocol } }` |
| `GET /api/session` | current `session.snapshot` result |
| `POST /api/rpc` | `{ method, params }` forwarded to herdr; allowlisted methods only |
| `GET /api/fs/dirs?path=` | subdirectories of a path under the workspace root, for the new-workspace picker |
| `GET /api/ports` | listening TCP ports in the namespace with process name and pid |
| `GET /api/lavish` | `{ configured, url, sessions: [{ key, label, file, status, url }] }` |
| `WS /ws/events` | first message `{ kind: "snapshot", snapshot }`, then `{ kind: "event", event, data }` verbatim from herdr, plus `{ kind: "ports", ports }` on change and `{ kind: "reset" }` after a herdr reconnect |
| `WS /ws/terminal?pane=<id>` | terminal stream, described below |
| `ANY /preview/:port/*` | reverse proxy to `127.0.0.1:<port>`, prefix stripped, WebSocket upgrades forwarded; `/preview/:port` redirects to the trailing-slash form |
| `GET /*` | the app, with `index.html` fallback for client routes |

The RPC allowlist covers `session.snapshot`, `workspace.*`, `worktree.*`,
`tab.*`, `pane.*`, `agent.*`, `layout.*`, `notification.show` and `ping`.
Everything else, including `server.stop`, `integration.*` and `plugin.*`, is
refused with 403. The client never speaks to herdr directly.

### Terminal streams

For each pane with at least one viewer, the bridge runs one
`herdr terminal session control <pane_id> --cols C --rows R` child. Its stdout
is newline-delimited JSON `terminal.frame` records carrying base64 ANSI bytes
and a `full` flag; its stdin accepts `terminal.input`, `terminal.resize`,
`terminal.scroll` and `terminal.release`. herdr renders the viewport server
side, so the browser terminal never needs scrollback of its own: wheel events
become `terminal.scroll` and herdr moves the viewport.

Bridge behaviour:

- Frames are decoded from base64 and sent to every viewer of that pane as
  binary WebSocket messages. Control messages from the browser are JSON text
  frames with the same shapes as the CLI commands.
- Size follows the viewer that interacted last, matching herdr's rule for
  multiple clients viewing one tab. A viewer sends its size on connect, on
  resize and when it takes focus.
- A viewer that joins a pane that already has a stream must receive a full
  repaint. The bridge keeps the last `full: true` frame and the diff frames
  since it, and replays them to the newcomer. If that buffer exceeds 1 MB, the
  bridge instead forces a repaint by resizing the stream to the newcomer's size.
  Implementers must verify empirically that a same-size resize produces a full
  frame; if it does not, alternate by one column and back.
- When the last viewer leaves, the bridge sends `terminal.release` and ends
  the child. A `terminal.closed` record ends every viewer's socket with a
  reason.
- The `--takeover` flag is used so that a stale controller from a crashed
  bridge cannot block a new one.

### Ports

Every two seconds while any events client is connected, read
`/proc/net/tcp` and `/proc/net/tcp6`, keep sockets in `LISTEN` state bound to
loopback or any address, and map inode to pid and process name through
`/proc/*/fd`. Ports owned by agentbox's own services (code-server, ttyd,
the bridge, lavish) are labelled so the UI can hide them by default. Changes
are pushed as `{ kind: "ports" }`.

### Lavish

lavish-axi binds loopback and refuses requests whose `Host` is not on its
allowlist, and its client uses absolute paths, so it cannot be served under
`/workbench` and cannot be proxied under a path. It gets its own hostname. The
bridge reads sessions from lavish's `state.json` (verify the shape in
`src/store.js` of lavish-axi) and, when lavish is running, from
`GET http://127.0.0.1:4387/health`, whose `listeners` are the sessions an
agent is actively polling. Each session's browser URL is
`<WORKBENCH_LAVISH_URL>/session/<key>`. When `WORKBENCH_LAVISH_URL` is unset
the panel explains how to configure it rather than showing a broken frame.

## The app

Vite, React 19, TypeScript, `@xterm/xterm` with the fit, WebGL and web-links
addons, `zustand` for state, `lucide-react` for icons. Plain CSS with design
tokens; no CSS framework. Fonts: system UI stack for chrome, JetBrains
Mono (OFL) bundled for terminals.

The app is served under a base path. Vite builds with `base: "./"` so assets
resolve relatively, and at runtime the app derives its API and WebSocket base
from `location.pathname` (everything up to and including the first segment).
One build therefore serves any base path.

### Layout

```
┌──────────┬────────────────────────────────────────┬──────────────┐
│ Sidebar  │ Tab bar for the focused workspace       │ Inspector    │
│          ├────────────────────────────────────────┤ (drawer)     │
│ Work-    │                                        │              │
│ spaces   │  Pane grid: split layout from herdr,   │  Preview     │
│  ▸ tabs  │  each cell a terminal with a slim      │  ─────────   │
│          │  header (title, agent badge, actions)  │  Lavish      │
│ Agents   │                                        │              │
│  blocked │                                        │              │
│  first   │                                        │              │
│          ├────────────────────────────────────────┤              │
│ status   │ Composer (shown when the focused pane  │              │
│ theme    │ hosts an agent)                        │              │
└──────────┴────────────────────────────────────────┴──────────────┘
```

- **Sidebar.** Workspaces in herdr order, each with a rollup dot (blocked >
  working > done > idle > none) and an expandable tab list. Below, an Agents
  section listing every detected agent across workspaces, blocked first, then
  done, then working, then idle; clicking focuses that pane. Footer: herdr
  connection status, theme toggle, sidebar collapse. `prefix+b` toggles it.
- **Tab bar.** Tabs of the focused workspace with rollup dots, a new-tab
  button, rename on double click, close on the tab's menu.
- **Pane grid.** Computed from the tab's `PaneLayoutSnapshot` rects, scaled
  to the container. Split borders are draggable and commit through
  `layout.set_split_ratio` on release. Each pane has a header with the pane
  title (agent name when detected, otherwise the terminal title or shell),
  agent state badge, cwd, and a menu: split right, split down, zoom, rename,
  close. The focused pane has a visible focus ring; clicking a terminal
  focuses it and calls `pane.focus`.
- **Terminal cell.** One xterm.js instance per visible pane, fitted to its
  cell. Keystrokes go to the stream as `terminal.input`. Wheel and touch
  scroll go as `terminal.scroll`. Resize sends `terminal.resize`. Links are
  clickable; a link to a localhost port opens the preview panel on that port.
  Selection copies on mouse-up like the TUI. Paste is supported.
- **Composer.** When the focused pane hosts an agent, a single-line field at
  the bottom sends its text through `agent.prompt` on ⌘/Ctrl+Enter, with the
  agent's state shown beside it. It disappears when the pane has no agent.
- **Inspector drawer.** Opens from the right, resizable, with a segmented
  control: Preview, Lavish. Closed by default; opens automatically the first
  time a port appears or a link is clicked, and remembers its state.
  - Preview: a list of listening ports with process names (system services
    hidden behind a toggle), an address bar showing the path within the
    selected app, refresh, open-full-screen (new tab, using the preview
    domain if configured, otherwise the proxied path), and a device-width
    control (responsive, 390, 768, 1024). The frame is an iframe to
    `/preview/<port>/<path>`.
  - Lavish: session list with label, file and status; the selected session
    in an iframe; open-full-screen; a setup card when unconfigured.
- **Command palette.** ⌘/Ctrl+K. Fuzzy over workspaces, tabs, panes and
  agents, plus actions: new workspace, new worktree, new tab, split right,
  split down, zoom, rename pane, close pane, close tab, close workspace,
  next blocked agent, toggle sidebar, toggle inspector, toggle theme, open
  preview on port N.
- **Dialogs.** New workspace (label, directory picker rooted at the workspace
  root, optional "create as git worktree" with branch and base), rename
  (workspace, tab, pane), confirm close when a pane has a running agent.
- **Notifications.** A toast when an agent becomes blocked or done in a pane
  that is not focused; the document title shows the blocked count; browser
  notifications when permission was granted, requested from the settings
  popover, never on load.

### Keyboard

When a terminal is focused, keys go to the terminal except `ctrl+b`, which
arms prefix mode for one keypress and shows a small HUD. The default herdr map
is honoured:

| Keys | Action |
| --- | --- |
| `prefix+c` | new tab |
| `prefix+v` / `prefix+-` | split right / down |
| `prefix+h/j/k/l` | focus pane left/down/up/right (`pane.focus_direction`) |
| `prefix+shift+h/j/k/l` | swap pane |
| `prefix+z` | zoom |
| `prefix+x` / `prefix+shift+x` | close pane / close tab |
| `prefix+n` / `prefix+p` / `prefix+1..9` | tab navigation |
| `prefix+shift+n` / `prefix+shift+w` / `prefix+shift+d` | workspace new / rename / close |
| `prefix+w` / `prefix+g` | open the palette on workspaces / on everything |
| `prefix+b` | toggle sidebar |
| `prefix+q` | blur the terminal (the browser equivalent of detach) |
| `prefix+ctrl+b` | send a literal `ctrl+b` |
| `prefix+?` | show the keymap |

Outside a terminal, the same actions are on ⌘/Ctrl shortcuts and in the
palette. `Esc` closes any overlay.

### Theme

Design tokens on `:root` for the light theme, overridden under
`[data-theme="dark"]`, with `prefers-color-scheme` supplying the default. The
toggle cycles system, light, dark and persists to `localStorage`. The terminal
theme (ANSI palette, cursor, selection) switches with the app theme. Both
palettes meet WCAG AA for text on their surfaces.

### State

One zustand store holding: connection status, the session (workspaces, tabs,
panes, layouts, agents, focus ids), ports, lavish sessions, UI state
(sidebar, inspector, palette, dialogs, theme), and per-client "seen" tracking
for done badges, mirroring herdr's rule that each client clears its own Done
badges. A reducer applies herdr events to the session exactly as documented:
`layout_updated` replaces the layout for that tab, `*_closed` removes, and so
on. The reducer is pure and unit-tested against recorded event fixtures.

## Docker and compose

- The sandbox image gains: the `herdr` binary (pinned version, SHA-256
  verified, like ttyd), `tmux` and `gh` (for firstmate), `lavish-axi` (global
  npm alongside the agents), and the built Workbench under
  `/usr/local/lib/agentbox-workbench` with a launcher at
  `/usr/local/bin/agentbox-workbench`.
- New services: `workbench` (command `agentbox-workbench`) and `lavish`
  (command `lavish-axi server`, with `LAVISH_AXI_IDLE_TIMEOUT_MS=0`,
  `LAVISH_AXI_ALLOWED_HOSTS` and `LAVISH_AXI_LINK_HOST` derived from
  `AGENTBOX_LAVISH_DOMAIN`). Both use the sandbox anchor and shared
  namespaces.
- `terminal` runs `herdr` instead of `bash -l`, so `/terminal` is the TUI
  attached to the same server. A `/shell` route keeps the plain shell.
- Healthchecks: the bridge's `/api/health`; lavish's `/health`.

## Proxy

Both Caddyfiles gain:

- `handle /workbench* { reverse_proxy code:7800 }` (the shared namespace means
  every sandbox port is reachable through the `code` service name).
- `handle /shell* { reverse_proxy code:7683 }`, backed by a new `shell`
  service running `ttyd --base-path /shell bash -l` on port 7683.
- A `lavish.{$AGENTBOX_DOMAIN}` site (standalone) or a `Host` matcher
  (behind-proxy) forwarding to `code:4387` with the same basic auth.
- An opt-in wildcard site `*.{$AGENTBOX_PREVIEW_DOMAIN}` that rewrites to
  `/preview/<port>/` on the bridge using the leading label of the hostname,
  again behind basic auth. In standalone mode it uses on-demand TLS with an
  `ask` permission that only accepts hostnames matching `^\d+\.` followed by
  the preview domain, so no DNS-provider plugin is needed. Behind Cloudflare
  Tunnel the preview domain should be the zone apex, because Universal SSL
  covers one level of wildcard only.

Basic auth is per origin, so each new preview hostname prompts once. That is
documented as a known trade-off; Cloudflare Access removes it for tunnel users.

## Security

- The bridge never exposes the raw socket; the RPC allowlist is enforced
  server side and tested.
- The preview proxy only targets `127.0.0.1`, only numeric ports 1 to 65535,
  and refuses the bridge's own port to prevent loops.
- The directory picker is confined to the workspace root; paths are resolved
  and checked for escape.
- No secrets in the bridge. Agent credentials stay where they are.
- The Docker socket, host mounts and privileges remain absent. `docs/security.md`
  gains a paragraph about shared namespaces between sandbox containers.

## Testing

- **Unit (vitest):** session reducer against fixtures recorded from a real
  herdr; layout scaling; key-combo parsing and prefix state machine; port
  parser on sample `/proc/net/tcp` content; RPC allowlist; base-path rewriting.
- **Bridge integration:** spawn a real `herdr server` with a temporary
  `HERDR_SOCKET_PATH`, then assert snapshot delivery, event fan-out, terminal
  round trip (send text, expect it in the frame stream), repaint on second
  viewer, release on last viewer, and preview proxying against a local HTTP
  server. herdr is a static binary, so CI installs it with the same pinned
  version the image uses.
- **End to end (Playwright):** boot herdr and the bridge, load the app,
  create a workspace, see a terminal, type a command and read its output,
  split a pane, toggle the theme, open the preview panel on a test server.
- **CI:** lint, typecheck, unit, integration and the e2e smoke run on every
  push; the image build asserts `herdr`, `lavish-axi` and `agentbox-workbench`
  are present; Caddy validation covers the new sites.

## Documentation

- `docs/workbench.md`: what it is, the layout, the keymap, previews (path
  mode versus hostname mode and which frameworks need which), lavish setup,
  the firstmate workflow, and troubleshooting.
- README: entry-point table gains `/workbench`, `/shell` and the two
  hostnames; the tunnel section gains the preview-domain note.
- `docs/security.md`: shared namespaces paragraph.
- `.env.example`: `AGENTBOX_PREVIEW_DOMAIN`, `AGENTBOX_LAVISH_DOMAIN`.

## Delivery

Work lands as a sequence of focused commits on `master`, each with an
imperative subject and a body explaining why, in the style of the existing
history, with no tool attribution trailers. Approximate order:

1. Share network and PID namespaces across the sandbox services.
2. Add herdr, tmux, gh and lavish-axi to the sandbox image; `/terminal`
   becomes herdr, `/shell` keeps bash.
3. Bridge: herdr connection, snapshot, events, RPC allowlist, tests.
4. Bridge: terminal streams, ports, preview proxy, lavish, tests.
5. App: design tokens, theme, shell layout, sidebar, tabs.
6. App: pane grid, terminals, keyboard model, palette, dialogs.
7. App: inspector with preview and lavish panels, notifications, composer.
8. Image build stage, `workbench` and `lavish` services, Caddy routes.
9. Documentation and CI.
