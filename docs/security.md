# Security model

agentbox assumes the VPS it runs on may host other workloads. The sandbox is
designed so that compromising the browser-facing environment does **not** hand
over the host.

## What the sandbox cannot reach

| Boundary | How it is enforced |
| --- | --- |
| The Docker daemon | The host's socket is never mounted. A container with `/var/run/docker.sock` is root on the host; agentbox does not use it, and `docker compose config` will show no such mount. With [Docker inside the sandbox](#docker-inside-the-sandbox) on, the sandbox gets the socket of a Docker Engine of its own, rootless, in a container beside it, never the host's. |
| The host filesystem | No bind mounts. `/workspace` is a named Docker volume; nothing from `/`, `/home`, or `/etc` is exposed. |
| Other stacks' data | The sandbox is on its own bridge network (`agentbox_internal`) with no route to another stack's private network, so their databases and internal services are not reachable. |
| The host itself | This is **not** automatic. `agentbox_internal` is an ordinary bridge, so by default a container can route to the host's own services (a management UI, SSH, a deploy webhook) through the bridge gateway, exactly as any Docker container can. On a shared host you must block it: see "Isolating the sandbox from the host" below. A single-purpose host with nothing else on it does not need this. |
| Privilege escalation | Every container has `cap_drop: [ALL]`, and every one but Docker's engine (below) has `no-new-privileges:true`. The sandbox's processes run as UID 1000 and the gate as UID 10001, never root; both hold no capabilities, and the gate's filesystem is read-only. The proxy (Caddy's image) runs as root inside its own container, which holds no capability but `NET_BIND_SERVICE` (for :80/:443) and has a read-only filesystem apart from its certificate volumes. None of the three can raise its privileges. One more container runs, and exits, before the sandbox starts: `home-init`, root in the sandbox's image with only `CHOWN` and `DAC_READ_SEARCH`, no network and only the home volume mounted. It gives UID 1000 back whatever in its home it does not own (left by older images), changing symbolic links themselves, never their targets, and staying on that volume. With [Docker inside the sandbox](#docker-inside-the-sandbox) on, one more runs: the engine, as UID 1000, holding `SETUID` and `SETGID` for its user namespace, without `no-new-privileges` and with seccomp unconfined; it is not privileged. |
| Host resources | CPU and memory ceilings per service, plus a PID limit (`AGENTBOX_PIDS`, 4096 per container), so a runaway agent cannot starve the host. Docker's engine, when on, has ceilings of its own (`AGENTBOX_DOCKER_CPUS`, `AGENTBOX_DOCKER_MEMORY`, 4096 processes), which bound every container the agents start in it. |

## What the sandbox *can* reach

- The public internet (outbound). Coding agents need it to reach their APIs, and
  package managers need it to install dependencies. If you want to restrict this,
  see "Egress filtering" below.
- Its own named volumes, the workspace and home, which persist across
  restarts and updates.
- The other sandbox services. `terminal`, `shell`, `ssh`, `monitor` and
  `workbench` share the `code` container's network and PID namespaces, so
  `localhost` and the process table are common to all of them. This is
  deliberate: a dev server an agent starts in one pane is reachable as an app
  from the others. The shared namespaces belong to sandbox containers only;
  nothing about the host boundary changes.
- The gate's public listener (:7900), on the internal network, exactly as an
  anonymous visitor would: the sign-in page, rate-limited sign-in, a shared
  app, and nothing else. It is keyed on its own address there and cannot
  claim another, and it cannot read or write the gate's store. It cannot
  reach the proxy at all.
- With [Docker inside the sandbox](#docker-inside-the-sandbox) on, its
  engine's socket: the sandbox can run, build and compose containers there,
  which share its network and reach nothing it cannot.
- The gate's app API (:7901), which is the sandbox's side of the app
  registry: it can register, change and remove apps — always private, never on
  one of agentbox's own ports — and nothing else (see "Apps" below).

## The front door

Two rules decide the shape of everything that follows:

1. **Whatever decides who gets in lives outside the sandbox.** The sandbox runs
   agents, and anything it holds an agent can change. So the password, the
   sessions, two-factor and device tokens live in the **gate** — a container of
   its own, from its own image, running as its own user (uid 10001, not the
   sandbox's 1000), with a read-only root filesystem, no capabilities, and a
   volume (`agentbox_gate`) that no sandbox container mounts.
2. **No front-door credential ever enters the sandbox.** Before Caddy's basic
   authentication was replaced, the password itself travelled to the editor and
   the bridge on every request, where a process in the sandbox could have read
   it. Now the gate strips `Authorization`, `Proxy-Authorization`, its session
   cookie and its app-grant cookie from every request and WebSocket upgrade it
   forwards, whatever the route; and it drops any `Set-Cookie` from the sandbox
   that would set or clear one of its own cookies.

Every request goes proxy → gate → sandbox. The proxy (Caddy) terminates TLS in
standalone mode, compresses, works out the client's address, and forwards
everything to the gate; it authenticates nothing and routes nothing. The proxy
and the gate share a network (`agentbox_front`) with nothing else; the gate and
the sandbox share another (`agentbox_internal`). The sandbox cannot reach the
proxy.

- **Routing on the raw path.** Before anything else, the gate refuses (`400`)
  any raw path with a dot-segment, `%2e`, `%2f`, `%5c`, a backslash, `;` or
  `//` — forms that one parser normalises and another does not — so no
  difference between Caddy, the gate and an upstream can move a request from
  one branch to another. An escaped ordinary character (`%65` for `e`) is then
  read as the character, as the bridge's router would read it, and that one
  spelling is both routed and forwarded: `/ws/%65ditor` is `/ws/editor` to
  every layer. Then, on that path: `/login` and the gate's own `/_gate/*` API,
  exactly `/cli/install` and `/cli/agentbox.mjs` (the CLI, below) and the
  device-approval page stay in the gate; `/a/<id>/…` is an app, decided by the
  app policy (below) and served from the bridge's data plane; `/vscode/*` goes
  to code-server with the prefix stripped — except code-server's own port
  proxy (`/vscode/proxy/…`, `/vscode/absproxy/…`, in any letter case), which
  would serve any sandbox port on the box's origin outside the app policy:
  the gate answers `404`, and code-server runs with `--disable-proxy` besides; `/terminal`, `/shell` and
  `/monitor` go to their ttyd services unchanged; everything else goes to the
  bridge unchanged.
- **Two exemptions, for names that are not the box's.** A WebDAV client names files in the path,
  and a filename may hold `;`, a backslash or `%5c`. So under `/api/dav/` the
  gate judges only that exact prefix: the rest of the path is not held to the
  check above, and the request goes to the bridge, raw and unchanged, and
  nowhere else. That is decided before any other route, so no spelling under
  `/api/dav/` — encoded dots and slashes included — can reach code-server or a
  ttyd service; the bridge's WebDAV handler then judges each segment itself
  and confines every name to the workspace. Anything that merely resembles the
  prefix (`/api/davx`, `//api/dav/`, `/api%2fdav/`) is judged whole, and the
  mount is behind sign-in like everything else. Likewise an app's own URLs
  under `/a/<id>/` (an app may use `%2F` or `;` in its paths): only that
  prefix, with a well-formed id, is judged, and the rest goes to the data
  plane — which takes the port from the gate's record and hands the rest of
  the path to that port on the sandbox's loopback, so no spelling of it can
  reach another service. Where a browser is sent back to after signing in is
  held to the strict form, with neither exemption.
- **The editor channel stays inside.** `/ws/editor` is how the editor extension
  in the sandbox hears "Open in editor"; the gate answers `404` for it and for
  anything under it, under any spelling, signed in or not, so only the
  sandbox's own loopback
  reaches it (and the bridge refuses it too if a request arrives with an
  `Origin` or forwarding headers).
- **Nothing without a session or a device token.** A page load without one is
  sent to `/login?next=<where it was going>`; any other request gets `401`. The
  only routes open without one are the sign-in page and its assets, sign-in
  itself, the two calls a device login makes (below), the CLI download, and
  an app the owner has shared (below). A request from the sandbox to the gate
  is treated as any anonymous client.
- **No service workers outside the editor.** A worker controls every page in
  its scope, for as long as it stays registered — one registered by a page the
  sandbox serves could answer `/login` with a lookalike. The gate refuses
  (`403`) any request for a worker's script (`Service-Worker: script`) except
  under `/vscode/`, where code-server keeps its own, and strips
  `Service-Worker-Allowed` from every response, so no worker's scope reaches
  above its script's directory. The gate's pages (`/login`, `/_gate`,
  `/settings/devices`, `/cli`) are outside every scope a permitted worker can
  have.
- **Sessions.** Cookie `__Host-agentbox`: `HttpOnly; Secure; SameSite=Lax;
  Path=/`, 256 random bits, stored only as a SHA-256 digest. A session ends
  after 12 hours without use — a request, or typing into a terminal it opened —
  unless "Remember this device" was ticked; no session outlives 30 days.
  Changing the password or two-factor ends every other session. Every way a
  session ends — signing out, ending it from another one, idling out, its 30
  days, being the oldest of more than 50, a password or two-factor change, the
  host's commands — also cuts every WebSocket it opened, a live terminal
  included; revoking a device token does the same. Because the cookie is
  `Secure`, the box must be reached over HTTPS (or on `localhost`).
- **Same-origin checks.** A state-changing request (anything but GET or HEAD)
  riding the session cookie must carry an `Origin` naming the box's own host —
  or, when the browser withheld the origin (`Origin: null`, or none), say
  `Sec-Fetch-Site: same-origin` — or it is refused `403` before it reaches the
  sandbox; that is cross-site request forgery closed off at the door, for
  sign-in and sign-out as well. (An opaque, sandboxed document also sends
  `Origin: null`, but with `Sec-Fetch-Site: cross-site`, and no page can set
  that header.) The gate's own pages are served with `Referrer-Policy:
  same-origin` so their forms carry a real `Origin`. A WebSocket upgrade on a
  session must carry an `Origin` naming the box's host too, so a page in
  another tab cannot open a terminal on your cookie. (ttyd's `--check-origin`
  and the bridge's own upgrade check still apply behind it.) Device tokens are
  exempt: a page on another site cannot attach an `Authorization` header.
- **Fresh credentials in the request.** What would let someone keep the box
  or lock you out needs the password — and a code, with two-factor on — sent
  with the request that does it, every time: approving a device, setting up,
  confirming or turning off two-factor, changing the password (the current one
  is mandatory), and revoking a device token other than the caller's own. The
  session alone is never enough, and nothing is remembered in between: there
  is no window after one confirmation in which a page running on the session
  (a sandbox page the owner opened, say) could do any of these without the
  password. Each check counts against the sign-in limits below. The approval
  page asks for the password in the same form. Ordinary use never asks.
- **Passwords.** bcrypt with cost 14, in the gate's store. `AGENTBOX_PASSWORD_HASH`
  in `.env` only seeds a store that does not exist yet (`./scripts/agentbox
  passwd` keeps it in step anyway, so restoring the stack's files cannot bring
  an old password back); every way of setting the password — the installer's
  `--password`, `passwd`, the account API — writes the store and ends
  sessions. A sign-in that checked the old password while it changed is
  refused. Passwords longer than bcrypt's 72 bytes are refused rather than
  silently truncated.
- **Rate limits and lockout, in every mode, before bcrypt.** Per client
  address (an IPv6 client: per /64): five password checks in any minute —
  sign-in and every sensitive action's own check count; from the fifth
  consecutive failure on, each further try waits 1 s, 2 s, 4 s, … after the
  last; ten consecutive failures lock the address out for 15 minutes, right
  password or not. Across all addresses, at most 30 checks a minute — a flood
  from many addresses can pause sign-in for everyone for that minute, but
  sessions already open are unaffected. A refused attempt costs a map lookup,
  not a bcrypt comparison, and the gate's CPU is capped besides. The gate's
  own endpoints must receive a whole request within 30 seconds (and every
  request its headers within 20), so slow senders cannot hold them.
  `./scripts/agentbox gate unlock` clears every lock.
- **Whose address.** Caddy works it out, because only the proxy knows whom it
  trusts in front of itself (`proxy/trust/`, chosen by the mode and
  `AGENTBOX_CLOUDFLARE`): in standalone mode nobody, so it is the address a
  request arrives from; behind another proxy or Traefik, that proxy (a private
  address), and walking `X-Forwarded-For` from the right past it; behind
  Cloudflare, Cloudflare's published ranges as well, with `CF-Connecting-IP`
  read only when every hop was trusted. An operator whose proxy writes the
  visitor's address into a header of its own can have Caddy read it first
  (`--real-ip-header`, `AGENTBOX_REAL_IP_HEADER`; behind another proxy only):
  that proxy must overwrite the header on every request, or a visitor can
  forge it and pick its own budget. Caddy writes the answer into
  `X-Agentbox-Client-IP`, dropping any copy a client sent, and the gate
  believes that header only on connections from the proxy — named `proxy` in
  compose, resolved in the background, and on a network the sandbox is not
  on. A request that reaches Traefik directly with forged headers is keyed on
  the address Traefik appends for it; one that calls the gate from the sandbox
  is keyed on its own. Residual: a client that itself has a private address —
  another container on a shared edge network, a machine on the host's LAN —
  can write what it likes further left in `X-Forwarded-For` and pick its own
  budget. It still meets the global ceiling, and it still needs the password.
- **Direct TLS (traefik mode, `--tls passthrough`).** Traefik passes the TLS
  connection through unopened and names the client in a PROXY protocol v2
  header; Caddy terminates TLS with its own Let's Encrypt certificate. The
  client is whom that header names, believed only from
  `AGENTBOX_PROXY_PROTOCOL_FROM` (every private range unless narrowed); a
  PROXY header from any other peer is ignored and the peer keyed on its own
  address, and no forwarding header — `X-Forwarded-For`, `CF-Connecting-IP`,
  a real-IP header — is believed from anyone. What that costs, plainly:
  - **No CDN in front.** The record is DNS-only, so the host's address is
    public and every visitor, a flood included, reaches it directly; nothing
    absorbs a volumetric attack before the host's own link.
  - **The gate's limits are the rate limiting.** Traefik's HTTP middlewares
    cannot act on a connection it does not open, so its outer limit (60
    requests a second per client) is gone; the gate's per-address and global
    sign-in limits above, its lockout and its request deadlines remain, and
    a flood of signed-out requests costs the gate a session lookup each.
  - Same residual as above: a container with a private address on the shared
    edge network can send Caddy a PROXY header of its own and pick its budget,
    unless `AGENTBOX_PROXY_PROTOCOL_FROM` is narrowed to Traefik's address or
    the edge network's subnet.
- **Two-factor (optional).** TOTP (RFC 6238: SHA-1, six digits, 30-second
  steps, one step of clock drift either way), each code usable once. Enrolling
  gives ten single-use recovery codes of 80 bits each, stored as SHA-256
  digests. A lost phone is fixed on the host with `./scripts/agentbox totp
  reset`.
- **Device tokens.** The CLI signs in with a device flow: it asks the gate for a
  code, the owner — signed in, in a browser, entering the password again —
  approves it on `/settings/devices?code=XXXX-XXXX`, and the CLI collects a
  token once. One client address (an IPv6 client: its /64) may have three
  logins waiting, one IPv6 /48 ten, and a hundred may wait in all. Tokens are `abx_` plus 256 random bits, stored as SHA-256 digests with a
  name, when they were made and last used, and from where; they work as
  `Authorization: Bearer` on every authenticated route, ttyd included. They
  cannot manage the account — sessions, the password, two-factor, approving
  another device — which takes a signed-in browser, and a token may revoke
  only itself. Revoke others from a signed-in browser with the password, or
  all of them with `./scripts/agentbox gate revoke-all`.
- **The CLI, served by the box.** `/cli/agentbox.mjs` (the bundle) and
  `/cli/install` (the script `curl … | sh` runs) are open-source files baked
  into the gate's image, served to anyone — and only those two exact paths:
  anything else under `/cli` is an ordinary authenticated route to the bridge.
  The gate writes the box's own origin into the install script (the configured
  public URL, or the request's `Host`) only when it is a plain
  `scheme://host[:port]`, between single quotes where the shell expands
  nothing. On the laptop the CLI keeps the device token in one file, readable
  by its owner alone, and never prints anything the box sends as terminal
  control. `agentbox mount` needs the token carried for the OS's WebDAV
  client, so it serves the box's `/api/dav/` on `127.0.0.1` only, answering
  only a loopback `Host` (no DNS rebinding), under a random 128-bit path, and
  only to HTTP Basic credentials made for that run (a random 192-bit
  password) that reach the mount helper outside its command line — except on
  Windows, whose WebClient sends Basic credentials only over https, so there
  the path is the only secret. It forwards nothing a normalising proxy could
  turn into a path outside `/api/dav/`. `agentbox forward` of one of
  agentbox's own ports hands that service to the laptop's loopback without
  the gate, and warns first. See [docs/cli.md](cli.md).
- **Headers.** Everything the gate serves carries `X-Content-Type-Options:
  nosniff` and — except its own pages, above — `Referrer-Policy: no-referrer`,
  and HTML carries `frame-ancestors 'self'`. The gate's own pages — sign-in
  and device approval — allow nothing but their own files (`default-src
  'none'`) and can never be framed (`frame-ancestors 'none'`), not even by
  the box's own origin, which also serves what the sandbox controls. HSTS
  stays with whatever terminates TLS.
- **Tunnels.** `GET /_gate/tunnel?target=tcp:<port>|herdr` is a WebSocket of
  raw bytes that `agentbox forward` and `agentbox herdr` ride. It takes a
  device token and nothing else — a page on another site can never attach
  one, so a browser's cookie never opens a tunnel — and reaches any port on
  the sandbox's loopback, agentbox's own included (the token holder is the
  owner), or herdr's socket, through the bridge's data plane. Revoking the
  token cuts every tunnel it opened.
- **The host's escape hatches** (`passwd`, `totp reset`, `gate unlock`,
  `gate revoke-all`) reach the running gate through a Unix socket in the gate
  container's private `/tmp`, so only a process already inside that container
  — `docker compose exec` from the host — can use them. With the gate stopped
  they edit the store directly, and refuse while any gate holds its lease on
  the volume.

### Apps

An app is a server in the sandbox with one URL, `/a/<id>/` on the box (the id
is 128 random bits). The registry is the gate's, in its own store: the
sandbox registers, changes and removes apps on the gate's :7901 listener —
which the proxy never forwards to, and which refuses the proxy's own address —
and every app it registers is private. Moving a shared app to another port
makes it private again, so the sandbox cannot point a public link at a server
the owner never shared. Who may open an app is changed only on
the gate's public side (`/_gate/apps/<id>/visibility`), by the owner's session
or device token. That takes no password in the request, unlike the account
changes above: a sandbox with internet access can publish itself through a
tunnel of its own anyway, so a password here would guard nothing that is not
already open, and sharing is an everyday action. Be clear about what that
means with egress restricted (see "Egress filtering"): then the sandbox has
no tunnel of its own, and sharing an app is a way out of it — through your
session. Script from a compromised sandbox running in a tab of yours (see
"What a compromised sandbox can still do") can call the sharing API as you and
publish an app, and so whatever the sandbox serves on it. The gate logs every
change of who may open an app; if you restrict egress because you distrust
what runs in the sandbox, run with `--sharing off`, or expect this. What the gate guarantees is
that nothing is public unless the owner said so, that agentbox's own services
never are (8080, 7681–7683, 2222, 7800, 7801, 7900, 7901 and any the operator adds
in `AGENTBOX_INFRA_PORTS` are refused as apps when registered, changed and
served), and that app content never runs with the box's origin. The
installer's `--sharing off` makes every app private and refuses to share any.

**Who opens an app**, in order: a valid **app grant** for that app; a session
or device token (a page load then mints a grant); anyone, when the owner
shared it with the link and it has not expired; anyone with the passcode,
when shared with one — the gate's own passcode page, checked against a bcrypt
hash, taken only from that page's own form (never another site's), and never
forwarded to the app. Guesses meet the sign-in limits per guessing address —
five a minute, then waits, and ten wrong in a row lock that address out for
15 minutes — counted apart from sign-in, so they never use up the owner's.
One guesser therefore locks out only itself. Above that, 200 wrong passcodes
for one app in ten minutes, from every address together, pause that app's
passcode page for everyone (the residual: a guesser with many addresses can
keep a passcode page paused; switch the app to a new passcode or to the link
alone). A passcode is at least 8 characters; the Share popover (and the API,
asked for a passcode without one) makes one of about 60 bits. Anything else:
a page load is sent to sign in, and any other request gets `404` — what an
unknown id gets, so a private app and a missing one look alike; those refusals
cost from a per-address budget of 60 a minute, so ids cannot be enumerated.

**The app grant** is cookie `__Secure-agentbox-app`: `Path=/a/<id>/;
HttpOnly; Secure; SameSite=None`, an HMAC-signed `{app, subject, expiry}`
under a key in the gate's store. The subject is the session, token or
passcode it was minted from, and a grant is good only while that is: ending
the session, revoking the token, or changing or removing the passcode voids
it. A grant from your session is minted when you open the app and lasts an
hour unused — the app's own requests renew it — so it exists only while you
have the app open, and for an hour after. `SameSite=None` because an app's
page has an opaque origin, so every request it makes is cross-site; the
cookie's path confines it to one app, and it opens nothing else — not the
control plane, not another app. What another site can do with it is below,
under the residuals.

**The font exemption.** `@font-face` loads are CORS requests that carry no
cookie, so a private app's own fonts would never carry its grant. A `GET` for
a `.woff2`, `.woff`, `.ttf` or `.otf` path of an existing app is let through
without one — it is forwarded to the app, with no credential, as any request
is — and the answer is passed back only when its content type is a font;
anything else becomes a `404` before a byte of it leaves the gate. So anyone
who knows a private app's id can make the app answer such a `GET` (the app
sees the request), and the most they get back is a font file.

**The app policy**, on every `/a/` exchange:

- *Opaque origin, always.* Every response carries `Content-Security-Policy:
  sandbox allow-scripts allow-forms allow-popups allow-modals
  allow-downloads`, added beside any policy the app sets; the Preview panel's
  frame has the same `sandbox` attribute, without `allow-same-origin`. The
  page gets no access to the box's origin — its cookies, storage, API or
  terminals — in the panel or opened full screen, and what the owner sees is
  what a visitor sees.
- *Credentials stay out.* The gate's cookies, `Authorization` and the
  passcode never reach the app; the app's own cookies do.
- *The app's cookies are its own.* `Set-Cookie` loses any `Domain`, has its
  `Path` put under `/a/<id>`, and is forced `SameSite=None; Secure`, so an
  app's own sign-in works in the panel and when shared, and its cookies reach
  nothing else. A `Set-Cookie` for one of the gate's cookie names is dropped.
- *Nothing that outlives the page.* `Service-Worker-Allowed`,
  `Clear-Site-Data` and `Strict-Transport-Security` are dropped; a worker's
  script is refused anyway, and an opaque origin cannot register one.
- *CORS for its own origin alone.* A request with `Origin: null` — the app's
  own page — is answered as credentialed CORS (`Access-Control-Allow-Origin:
  null`, `-Credentials: true`), and the gate answers its preflights itself;
  nothing is granted to any other origin. A state-changing request, or a
  WebSocket, that names another site as its origin is refused (`403`): the
  grant is `SameSite=None`, and another site's form must not ride it.
- *Redirects stay inside.* A root-relative `Location`, or one naming the app's
  own loopback address, is put under `/a/<id>/`.
- *Every exchange is tracked by what let it in.* Making an app private (stop
  sharing, or its link expiring — swept every 30 seconds, and judged on every
  request besides), changing its passcode, or removing it cuts every
  connection, stream and WebSocket that was let in as the public or by the
  passcode; ending a session or revoking a token cuts what it opened.

**Path fixes.** For an app written for `/`, the gate edits HTML and CSS as
they pass (root paths prefixed, an import map, a small runtime shim, module
scripts asked for with credentials) — see [the Workbench](workbench.md#apps).
The shim runs inside the app's own opaque page, so it grants the page nothing
it could not do itself. It is off per app (`compat: off`) for apps that do
not want it.

**The data plane.** The bridge listens twice: :7800, the app and its API, and
:7801, apps and tunnels only, which the gate alone reaches (as `code:7801`
across the internal network; the proxy is not on that network). The gate
sends only `/a/<id>/` requests there, as `/app/<port>/…` with the port from
its own record, and wraps every answer in the app policy — so "app content
never reaches the box's origin unsandboxed" is a fact of routing, not of path
matching. The data plane makes each request look local to the app (`Host`,
`Origin`, `Referer` name `127.0.0.1:<port>`) and reaches only the sandbox's
loopback, never one of agentbox's own ports for an app: nothing through it is
anything a process in the sandbox could not reach already.

`tests/proxy/gate-bypass.sh` proves the registry's limits, the private app's
404, the grant's scope, the stop-sharing cut-off, the proxy's lack of reach to
:7901 and the data plane, and the tunnel's token rule against the real gate
image; the fidelity suite (`npm run fidelity -w app`) proves the policy in
Chromium, Firefox and WebKit with real apps.

### SSH

The `ssh` service runs OpenSSH's sshd in the sandbox as the sandbox user
(uid 1000, no capabilities, `no-new-privileges`), sharing the editor's network
and process namespaces like the terminals. It listens on **127.0.0.1:2222 in
the sandbox only**: no port is published, and nothing on any Docker network
can reach it. It takes public keys only — no passwords, no keyboard-interactive,
no root (it could not log anyone but the sandbox user in anyway), and allows
local forwarding to the sandbox's own loopback alone (what VS Code's
Remote-SSH needs, and what a tunnel reaches anyway); no remote forwarding, no
agent or X11 forwarding, no tunnels, no Unix-socket forwarding. Its host key is
made once on the home volume.

From outside there are two ways in, each behind two independent locks:

1. **The gate's tunnel** (the default): `ssh <box>` runs `agentbox proxy
   tcp:2222`, a WebSocket to `/_gate/tunnel?target=tcp:2222` that the gate
   opens for a **device token** only — not a session cookie, not signed out
   (the gate bypass suite checks both). Then sshd wants a **key** in
   `~/.ssh/authorized_keys`. A stolen key without a token reaches nothing; a
   stolen token already opens every tunnel and the files API, key or not.
2. **Through the host** (`agentbox ssh-setup --via <host>`): `ssh <host>`, then
   `docker exec -i <the ssh container> agentbox-sshd -i`. The locks are your
   account on the host (with docker, which is root there) and the key.

The client pins the box's host key, fetched through the files API over the
authenticated HTTPS channel, under an alias of its own
(`HostKeyAlias agentbox-<box>`, in `~/.ssh/agentbox_known_hosts`), with
`StrictHostKeyChecking yes`.

What sshd does not do is add a boundary inside the box: it runs as the same
user as the agents, so anything in the sandbox can read its host key, add a
key to `authorized_keys` or change its settings (Include files under the ssh
container's `/tmp`). That gains nothing an agent does not already have, and a
key it adds still needs a device token, or the host, to be used from outside.

### What a compromised sandbox can still do

The box's one origin also serves what the sandbox controls: code-server, the
ttyd shells and the bridge's app are all programs inside it. So a compromised
sandbox can run script in your browser, on the box's origin, while you have a
tab of it open — and that script acts with your session, and could show a
lookalike prompt and read a password typed into it while it runs. With
internet egress it can also publish itself through a tunnel of its own; that
was always true (see "Egress filtering").

That includes the app's Settings screens. The forms that change the password,
turn two-factor on or off and revoke device tokens are part of the app, which
the bridge serves from inside the sandbox: a compromised sandbox could read
what you type there (the current password, a new one, a code). The gate's own
pages — `/login` and the device-approval page — are served by the gate and
can never be framed, not even by the box's own origin. **If you suspect the
sandbox, do not type the password into the app at all: change it on the host
with `./scripts/agentbox passwd`**, which never touches the sandbox, and end
every session and token with `./scripts/agentbox gate revoke-all`. When you
sign in again, open `/login` in a fresh tab you typed the address into, not
one the app opened.

What the gate guarantees regardless:

- nothing reaches the sandbox without a session or a device token;
- no front-door credential — the password, the session cookie, a token — is
  ever sent into the sandbox;
- no persistent takeover: no service worker outside the editor, so nothing the
  sandbox serves outlives the tab or answers for the gate's pages;
- no app is public unless the owner made it so, from outside the sandbox, and
  none of agentbox's own services is ever an app;
- app content never runs with the box's origin: every app is an opaque origin,
  in the Preview panel and full screen;
- the changes that would keep the box or lock you out — a new device, the
  password, two-factor, revoking tokens — need the password again (and a code,
  with two-factor on), not just the session.

`tests/proxy/gate-bypass.sh` runs the real Caddyfiles and the real gate image,
wired as compose wires them, against stand-ins for every sandbox port, a real
Traefik and a stand-in Cloudflare edge, and proves the first four; for direct
TLS, a real Traefik reads the overlay's labels and Caddy gets its certificate
from a local ACME server through the passthrough.

Residuals, stated plainly:

- **A sandbox with egress can publish itself**, through a tunnel service of
  its own (ngrok, cloudflared). agentbox's own front door never does it
  without the owner; blocking the rest is egress filtering (below).
- **Another site that knows a private app's id, while you have it open.** The
  grant is `SameSite=None`, so your browser sends it on requests any site
  makes to `/a/<id>/`. The app's own page is an opaque origin, and nothing a
  browser sends tells it apart from another site's sandboxed frame: both say
  `Origin: null` and `Sec-Fetch-Site: cross-site`, and an opaque document
  sends no referrer at all. So a site that knows the id, visited by you while
  you hold a grant for that app, **can read the app as you and act on it as
  you**: a sandboxed frame of its own can `fetch` the app with credentials
  and read the answer (the gate answers CORS for `null`, as the app's own
  page needs), and can make state-changing requests; a form it posts from a
  page with `no-referrer` arrives with `Origin: null`, exactly as the app's
  own form posts do. What it cannot do: anything without the id (128 random
  bits, never sent as a referrer by the box's pages or by an app's opaque
  pages); anything once the grant is gone — an hour after you last used the
  app, or at once when you sign out or your session ends; anything to
  another app, or to the box itself (the grant opens one app's path and
  nothing else); a state-changing request or WebSocket that names its own
  origin (refused). `Partitioned` cookies (CHIPS), which would keep the grant
  to the box as the top-level site, do not fit: in Chromium and Firefox the
  app's own requests from its opaque page fall in a different partition from
  the page load that set the grant, so the app stops working (the fidelity
  suite shows it), and WebKit ignores the attribute. Keep private app ids to
  yourself, sign out when you are done, and for an app that must not be
  reachable this way, `agentbox forward` it and work on `localhost`. The
  fidelity suite pins down both sides: another site gets nothing without the
  grant, after sign-out, or for another app; and it does get through while
  you have the app open (a test marked as expected to fail, in every engine).
- **A browser that blocks `SameSite=None` cookies for opaque documents** would
  lose a private app's grant for the page's own requests, the full-screen tab
  above all; public apps need no grant. The fidelity suite finds Chromium,
  Firefox and WebKit all sending it (in the panel and full screen); a browser
  set to block third-party cookies may not.
- **An app's own cookies** are forced `SameSite=None` for the same reason as
  the grant, so what the previous point says of the grant holds for them too:
  another site that knows the id reaches the app with them — a shared app's
  visitors' cookies included.
- **Apps are not isolated from each other by origin.** Every app is its own
  opaque origin in the browser, but they share the box's host name, so an
  app's server-set cookies are kept apart by path (`/a/<id>/`), not by
  origin. Apps are the owner's own code; use `agentbox forward` for an app
  that needs an origin of its own.

## The Workbench's own surface

- **The bridge is not published.** `workbench` listens on :7800 inside the
  shared namespace. Only the gate forwards to it, and only once a request is
  authenticated.
- **The RPC forwarder is an allowlist, not a passthrough.** The browser can
  call the herdr methods the app needs and nothing else; anything outside the
  list is refused before it reaches herdr.
- **Apps are not served here.** The control plane serves no app content at
  all: the old `/preview/<port>/` proxy on the box's origin and the old
  `/s/<token>/` share links (whose records lived inside the sandbox) are gone.
  Apps live on the data plane, under the gate's app policy (above). The
  bridge's `/api/apps` passes the sandbox's side of the registry through, with
  what is live in the sandbox; it cannot change who may open an app.
- **The bridge still guards its own paths.** It refuses (400) the same
  ambiguous path forms the gate does, in any path it routes (only the prefix
  of the WebDAV mount, whose handler judges each name itself).
- **WebSocket upgrades are origin-checked, twice.** The same-origin policy does
  not cover websocket handshakes, so a page in another tab could otherwise open
  `/ws/events` or `/ws/terminal` on your session cookie.
  The gate refuses a session's upgrade whose `Origin` is not the box's host,
  and the bridge checks again: a foreign origin, a missing one and the `null` a
  sandboxed document sends are all refused.
- **The Workbench cannot be framed** by another site: its pages are served with
  `frame-ancestors 'self'`, so it cannot be overlaid onto a live terminal.
- **The directory picker is confined** to the workspace root: `/api/fs/dirs`
  rejects any path that escapes it rather than resolving it. Creating a
  workspace or worktree is *not* so confined — those RPCs pass the directory
  you choose to herdr, which can open a session anywhere in the sandbox the
  agents can already reach.
- **Review artifacts are sandboxed twice.** A review artifact is HTML an agent
  wrote, rendered inside the authenticated app, so the route serves it with
  `Content-Security-Policy: sandbox allow-scripts` — an opaque origin, with no
  cookies, no storage and no same-origin access — and the panel's iframe
  carries `sandbox="allow-scripts"` as well. Two mechanisms, because only the
  header survives the page being opened as a top-level tab. The only channel
  across the boundary is `postMessage`, and the panel accepts messages from its
  own frame alone. Session keys are short hashes matched against that shape, so
  a `..` in a key is refused rather than resolved.

## Docker inside the sandbox

Off unless the owner turns it on (`install.sh --docker on`, or
`./scripts/agentbox update --docker on`). It adds one container,
`docker` from `docker-compose.docker.yml`: Docker's own
`docker:<version>-dind-rootless` image running `dockerd` in rootless mode, as
UID 1000, the same user the sandbox runs as. The agents reach it through
`DOCKER_HOST`, and can then run, build and compose containers of their own.

Treat it as part of the sandbox: anything in the sandbox can use the engine,
and the engine can do anything the sandbox can, and a little more, described
below. What it adds to the host's exposure is kernel surface, not access.

**What it can do**

- Run containers as root inside a user namespace of its own: root in there is
  UID 1000 outside, and its other UIDs are 100000 to 165535 (the image's
  `/etc/subuid`). Without user-namespace remapping in the host's Docker, those
  are the same numbers on the host. Its files live on the `agentbox_docker`
  volume, under Docker's root-only directory.
- Listen on the sandbox's network. It shares `code`'s network namespace
  (`network_mode: service:code`): a port published with `-p` listens there,
  on the sandbox's localhost and its address on `agentbox_internal`, exactly
  like a dev server, so Preview serves it as an app and the gate's app policy
  applies to it. Its containers' outbound traffic leaves through the same
  namespace (slirp4netns), so it is the sandbox's traffic: `--isolate-host`'s
  rules and any egress filtering cover it unchanged.

**What it cannot do**

- It is not privileged, holds no capability but `SETUID` and `SETGID`, mounts
  no host path and no Docker socket of the host's, publishes no port on the
  host, and has a process namespace of its own (it cannot see the sandbox's
  processes, nor they its).
- `docker run --privileged` inside it does not start: the kernel refuses it
  a writable `/sys` (the engine's own is read-only, and a namespace inside it
  cannot mount a more permissive one). `-v /:/host` mounts the engine's own
  filesystem. `--network host` is the engine's own namespace, with nothing
  of the host's networks in it.
- It has no TCP listener: one Unix socket, on an in-memory volume that only
  UID 1000 can open (mode 0700), mounted by the sandbox's containers and the
  engine alone. The gate and the proxy never see it.
- Resource limits on its containers (`docker run --memory`) are not enforced,
  as rootless Docker has no cgroups to enforce them with here; the engine's
  own ceilings bound everything it runs.

**What it needs, and why**

| Setting | Why |
| --- | --- |
| `cap_add: [SETUID, SETGID]` (everything else dropped) | `newuidmap` and `newgidmap` write the user namespace's UID and GID maps. They gain `CAP_SETUID` and `CAP_SETGID` from file capabilities, which the container's bounding set must hold. |
| no `no-new-privileges` | It would stop those two programs gaining their file capabilities, and the engine could not map more than its own UID. |
| `seccomp=unconfined` | Docker's default profile refuses `unshare`/`clone` of new namespaces, and `mount`, to a container without `CAP_SYS_ADMIN`; the engine makes user, mount and network namespaces and mounts its containers' filesystems inside them. |
| `systempaths=unconfined` | Docker masks parts of `/proc` and `/sys` in every container. The kernel will not mount a fresh `/proc` in a user namespace where the existing one has paths covered, so without this every container the engine starts fails at "mounting proc". |
| `/dev/net/tun` | slirp4netns gives the engine's namespace its network through a TAP device. |
| `/dev/fuse` | fuse-overlayfs, the storage driver on a kernel that refuses overlayfs in a user namespace. |

SELinux stays enforcing, and AppArmor is not changed. It is tested on a Rocky
Linux 10 host with SELinux enforcing, and on a host with neither SELinux nor
AppArmor. On a host where Docker confines containers with AppArmor (Ubuntu,
Debian), Docker's default profile may refuse the engine's mounts; agentbox
does not turn it off for you.

**What is left: the kernel.** Seccomp is the filter that keeps most of the
kernel's system calls away from a container, and user namespaces let an
unprivileged process reach kernel code otherwise kept for `CAP_SYS_ADMIN`
(mounting filesystems, configuring network namespaces). Both are where local
privilege escalations are usually found. A kernel bug reachable that way is a
way from the sandbox to the host's root, which a plain sandbox container
would not have had. Keep the kernel patched, keep SELinux enforcing, prefer a
rootless Docker on the host (where an escape lands in a user account), and
leave Docker off on a box that does not need it.

## Verifying the boundary yourself

Do not take the table above on trust; the claims are observable:

```bash
# No container mounts the Docker socket.
docker inspect $(docker compose ps -q) \
  --format '{{.Name}}: {{range .Mounts}}{{.Source}} {{end}}'

# The sandbox runs unprivileged with no capabilities.
for c in agentbox-code-1 agentbox-workbench-1 agentbox-terminal-1; do
  docker inspect "$c" \
    --format '{{.Name}} user={{.Config.User}} caps={{.HostConfig.CapDrop}} priv={{.HostConfig.Privileged}}'
done
```

Expect `User=1000:1000`, `CapDrop=[ALL]`, `Privileged=false`, and only
`/var/lib/docker/volumes/...` paths for the sandbox services.

```bash
# The gate is outside the sandbox: its own user, read-only, no capabilities,
# and the only container that mounts agentbox_gate.
docker inspect agentbox-gate-1 \
  --format 'user={{.Config.User}} ro={{.HostConfig.ReadonlyRootfs}} caps={{.HostConfig.CapDrop}}'
docker ps -a --filter volume=agentbox_gate --format '{{.Names}}'
```

Expect `user=10001:10001 ro=true caps=[ALL]`, and only the gate listed.

```bash
# With Docker inside the sandbox on: the engine is not privileged, holds
# SETUID and SETGID alone, shares the sandbox's network, and publishes nothing.
docker inspect agentbox-docker-1 \
  --format 'priv={{.HostConfig.Privileged}} caps={{.HostConfig.CapAdd}} drop={{.HostConfig.CapDrop}} net={{.HostConfig.NetworkMode}} ports={{.HostConfig.PortBindings}}'
# --privileged inside it does not start, and a host mount is its own filesystem.
docker exec agentbox-code-1 docker run --rm --privileged alpine true
docker exec agentbox-code-1 docker run --rm -v /:/host alpine ls /host
```

Expect `priv=false caps=[SETUID SETGID] drop=[ALL] net=container:<id>
ports=map[]`, the `--privileged` run refused ("error mounting sysfs"), and a
listing of the engine's own root.

## Rootless mode (recommended)

In `rootless` mode the Docker daemon itself runs as an unprivileged user, so a
container breakout lands in a user account rather than root. This is the
strongest configuration and is what the project recommends for shared hosts.

## Threat model, honestly stated

agentbox protects the **host** from the **sandbox**. It does not make the code
you run inside the sandbox safe. An agent with your API keys, working in your
repositories, can still push commits, spend tokens, and exfiltrate anything you
place in the workspace. Treat the sandbox as a machine you trust exactly as much
as the code and agents you put in it.

## Isolating the sandbox from the host

On a host that runs **only** agentbox, the default bridge is fine: there is
nothing else on the host to reach. On a **shared** host — one that also runs
other services, a management UI, or a deploy mechanism — you must stop the
sandbox routing to the host and to other private networks, because the sandbox
is the one place you hand an untrusted party a shell.

The sandbox legitimately needs the *public* internet and nothing on RFC1918.
So the rule is: from the sandbox's subnet, drop RFC1918 and the host, allow the
rest. Find the subnet with `docker network inspect agentbox_internal`, then, on
a host using nftables (adjust the subnet):

```
table inet agentbox {
	chain forward {
		type filter hook forward priority -10; policy accept;
		ct state established,related accept
		ip saddr 10.201.12.0/24 ip daddr 10.201.12.0/24 accept
		ip saddr 10.201.12.0/24 ip daddr 10.0.0.0/8 drop
		ip saddr 10.201.12.0/24 ip daddr 172.16.0.0/12 drop
		ip saddr 10.201.12.0/24 ip daddr 192.168.0.0/16 drop
		ip saddr 10.201.12.0/24 ip daddr 169.254.0.0/16 drop
	}
	chain input {
		type filter hook input priority -10; policy accept;
		ct state established,related accept
		ip saddr 10.201.12.0/24 drop
	}
}
```

The `forward` chain blocks routing to other private networks; the `input` chain
blocks the host's own services (a container reaches the host at its gateway
address, which is delivered locally and never touches `forward`). Load it with
`nft -f`, and make it survive a reboot with a `oneshot` systemd unit ordered
`After=firewalld.service docker.service` that runs the same command. Verify from
inside — `docker exec agentbox-code-1 curl` — that a host service is refused
while `https://api.github.com` still answers.

`169.254.0.0/16` is included because it carries the cloud metadata endpoint,
which on many providers hands out instance credentials.

## Egress filtering

The rules above already deny private-network egress. To restrict *public*
egress as well — so an agent cannot exfiltrate to an arbitrary host — attach
the sandbox to an `internal: true` network and route its outbound traffic
through a proxy you control. This is deliberately not the default: it breaks
most real workflows and gives a false sense of safety when half-configured.
