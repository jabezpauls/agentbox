# Installing

## Two commands

```bash
curl -fsSL https://github.com/jabezpauls/agentbox/releases/latest/download/install.sh -o install.sh
sudo bash install.sh --domain code.example.com
```

Or in one line, if you would rather not keep the file:

```bash
curl -fsSL https://github.com/jabezpauls/agentbox/releases/latest/download/install.sh \
  | sudo bash -s -- --domain code.example.com
```

Point `code.example.com` at the server first; the certificate is issued on your
first visit. The installer prints a generated password once; sign in with it at
`https://code.example.com/login` (any page sends you there).

What it does: installs Docker if it is missing, downloads the release bundle
(`agentbox.tar.gz`: the compose files, the proxy configuration, the scripts and
the image sources) to `/opt/agentbox`, checks it against the release's
`SHA256SUMS` before unpacking anything, pulls the prebuilt images from
`ghcr.io/jabezpauls/agentbox-workspace` and `-gate` (amd64 and arm64), writes
`.env` and starts the stack. Nothing is cloned and nothing is compiled. The
release is pinned in `.env` as `AGENTBOX_TAG`, so the box only moves to a new
version when you run `sudo ./scripts/agentbox update`. The installer ends by
printing the folder and the exact commands to use in it.

**Where it goes.** As root, or under `sudo`, the install goes to
`/opt/agentbox`, and its `.env` (which holds the password hash and API keys)
is readable by root alone, so the day-to-day commands below take `sudo`. A
normal user in the `docker` group can run the installer without `sudo`; the
install then goes to `~/agentbox` and its commands need no `sudo`. `--dir`
puts it anywhere else. An existing install stays where it is: a box installed
earlier in root's home (`/root/agentbox`) is found and updated there, and
`update` never moves one. Every example below assumes `/opt/agentbox`.

**Checksums.** A release whose `SHA256SUMS` cannot be downloaded, or does not
match, is refused by both `install.sh` and `update`, and nothing is unpacked.
A mirror that publishes no checksums (see `AGENTBOX_RELEASE_URL` under
[updating](#updating)) needs `AGENTBOX_INSECURE_SKIP_VERIFY=1` in the
environment of that one command; it then warns and goes ahead unchecked.

## Options

Run `install.sh` with **no options** for an interactive walk-through: it asks
the same questions the flags answer, with the safe default preselected, and
prints the resolved command before it runs anything.

| Flag | Default | What it does |
| --- | --- | --- |
| `--domain <host>` | — | The hostname you browse to. Required in standalone and traefik modes. |
| `--mode <mode>` | `standalone` | `standalone` owns :80/:443 and gets its own certificate; `behind-proxy` binds loopback only; `traefik` publishes no port and lets a container Traefik route to it. |
| `--bind <addr:port>` | `127.0.0.1:8443` | behind-proxy listen address. Must be loopback unless you also pass `--bind-public`. |
| `--bind-public` | off | Allow a `--bind` address other hosts can reach, for a proxy on another machine. It serves plain HTTP and believes `X-Forwarded-For` from any private address, so firewall it to your proxy alone. |
| `--edge-network <name>` | `edge-prod` | traefik: the external network your Traefik already watches. |
| `--cert-resolver <name>` | `letsencrypt` | traefik: the Traefik certificate resolver for this host. |
| `--tls <edge\|passthrough>` | `edge` | traefik: who terminates TLS — Traefik (`edge`), or this box's own Caddy with its own certificate, Traefik passing TLS through (`passthrough`, for a DNS-only record; implies `--cloudflare off`). See [direct TLS](#direct-tls-passthrough). |
| `--user` / `--password` | `admin` / generated | The sign-in. Only a bcrypt hash is stored, in the gate. On an existing install, `--password` replaces the current password and signs every session out. |
| `--sharing <on\|off>` | `on` | Whether you may share an app from the Preview panel (anyone with the link, or a passcode, for as long as you choose). `off` keeps every app private. `--preview path\|off`, its old name, still works. See [sharing apps](workbench.md#sharing-an-app). |
| `--cloudflare <on\|off>` | `on` in traefik mode, else `off` | The hostname is proxied through Cloudflare (or reached through a Cloudflare Tunnel). Decides whose address sign-in limits count; see below. |
| `--real-ip-header <name>` | none | behind-proxy/traefik: a header your own proxy writes the visitor's address into and overwrites on every request (e.g. `X-Real-IP`), read before `X-Forwarded-For`. Rarely needed; see [behind-proxy](#if-something-already-serves-ports-80-and-443). |
| `--agents <list>` | `claude,codex` | Which coding agents the sandbox carries, comma-separated (`claude`, `codex`). `herdr` is always installed. The prebuilt image has both; any other list builds the image on the server. See [below](#choosing-coding-agents). |
| `--version <tag>` | the latest | The release to install, e.g. `v1.2.0`. On an existing install, moves it to that release. |
| `--build` / `--no-build` | off | Build the images on the server from the release's sources instead of pulling them, or go back to pulling. |
| `--from-git` | — | Clone the repository into `--dir` and build from it, the way installs worked before releases. See [from a clone](#from-a-clone). |
| `--isolate-host` | off | Firewall the sandbox off the host and other private networks — see below. |
| `--cpus` / `--memory` | `2` / `4g` | Sandbox ceilings per service. |
| `--proxy-cpus` / `--proxy-memory` | `1` / `256m` | Proxy container ceilings. |
| `--dir <path>` | `/opt/agentbox` as root or under sudo, else `~/agentbox` | Where to install. Run from inside a clone, the clone itself. An existing install is kept where it is. |
| `--yes` | — | Do not prompt. |

Re-running the installer keeps every setting you already have — mode, domain,
caps, API keys, anything you added to `.env` by hand, and the release — and
changes only the ones you pass. Run it again from the install folder
(`sudo bash /opt/agentbox/install.sh --isolate-host`, say), or download it again. `install.sh --isolate-host` on an existing traefik box adds the
firewall and leaves it a traefik box. The password is kept unless you pass
`--password`. `--preview-domain` is still accepted, and ignored with a warning:
per-port preview hostnames were removed.

### traefik mode

When your reverse proxy is itself a container, prefer `traefik` mode over
`behind-proxy`: it publishes no host port at all and attaches to the external
network Traefik already watches, so nothing binds a routable host address.

```bash
sudo bash install.sh \
  --mode traefik --domain code.example.com \
  --edge-network edge-prod --cert-resolver letsencrypt
```

The gate keeps authenticating every request inside the stack, so the sandbox is
never reachable unauthenticated even from another container on that network.
Traefik's own rate limit stays in front of it as an outer ceiling.

traefik mode assumes the hostname is proxied through Cloudflare
(`--cloudflare on`, the default here): Caddy then trusts Traefik and
Cloudflare's published ranges when it works out whose address a sign-in comes
from, and a client that reaches Traefik directly, forging Cloudflare's
headers, is still counted as itself. If nothing fronts Traefik, pass
`--cloudflare off`. Cloudflare's ranges ship with agentbox;
`scripts/refresh-cloudflare-ips.sh` refreshes them if Cloudflare ever changes
them.

#### Direct TLS (passthrough)

`--tls passthrough` serves the hostname with a DNS-only (grey-cloud) record
and a publicly trusted certificate of the box's own, through the same shared
Traefik, without touching Traefik's configuration. Use it when you want
browsers to reach the host directly — no Cloudflare hop, so lower latency for
the terminals and the editor — but Traefik cannot present a public
certificate for the name (say it serves `*.example.com` with a Cloudflare
Origin CA wildcard, which only Cloudflare trusts).

```bash
sudo bash install.sh \
  --mode traefik --domain code.example.com --edge-network edge-prod --tls passthrough
```

What changes (`docker-compose.traefik-passthrough.yml`, used in place of
`docker-compose.traefik.yml`):

- Traefik gets a **TCP** router on `websecure` with
  ``HostSNI(`code.example.com`)`` and TLS passthrough, so it forwards the
  connection unopened to Caddy's :443, prefixed with a PROXY protocol v2 header
  naming the client. Only labels on agentbox's own proxy container do this.
- Caddy terminates TLS with a Let's Encrypt certificate it gets over
  **TLS-ALPN-01**, on the same :443 connection — nothing needs :80. The
  certificate and the ACME account live in the `caddy_data` volume.
- Caddy believes the PROXY header only from `AGENTBOX_PROXY_PROTOCOL_FROM`
  (every private range by default; narrow it to the edge network's subnet,
  e.g. `AGENTBOX_PROXY_PROTOCOL_FROM=172.18.0.0/16`, if you like), trusts no
  forwarding header at all, and sets HSTS and `nosniff` itself.
- Traefik's HTTP middlewares cannot act on a connection it does not open, so
  its rate limit no longer applies; the gate's own sign-in limits are the rate
  limiting (see [docs/security.md](security.md)). `--cloudflare` and
  `--real-ip-header` do not apply.

Requirements on the shared Traefik, none of which you change:

- **No HTTP router with an exact `Host` rule for this name on `websecure`.**
  Traefik prefers one over a TCP router for the same name. A wildcard
  (`HostRegexp`) router is fine: the exact `HostSNI` TCP router wins over it.
  agentbox's own edge-mode HTTP router goes away with the overlay switch.
- **No certificate resolver using `tlsChallenge`** (unless `websecure` sets
  `allowACMEByPass`). With one, Traefik answers every TLS-ALPN-01 challenge
  itself, and Caddy never gets a certificate. DNS-01 and HTTP-01 resolvers are
  fine.

Cutover from edge mode, in order:

1. Deploy: `sudo ./scripts/agentbox update --tls passthrough` (or re-run
   `install.sh --tls passthrough`). This sets `AGENTBOX_TLS=passthrough` and
   `AGENTBOX_CLOUDFLARE=off` and recreates the proxy with the TCP router.
   While the record is still proxied, Cloudflare cannot complete the TLS
   handshake with the box: the site is down until step 2.
2. Set the DNS record to **DNS-only** (grey cloud), pointing at the host.
3. Caddy asks for the certificate as it starts and retries with backoff (a
   minute, then two, then longer). Rather than wait,
   `sudo ./scripts/agentbox restart` once the record resolves to the host; the
   certificate arrives within seconds. `sudo ./scripts/agentbox logs proxy` shows
   `certificate obtained successfully`.

To go back: `sudo ./scripts/agentbox update --tls edge --cloudflare on`, and set the
record back to proxied. The edge settings (`--cert-resolver`) were kept.

### Choosing coding agents

The agents in the image are a build-time choice. The prebuilt image has the
default, `--agents claude,codex`. Any other list builds the sandbox image on
the server, from the sources in the release bundle: `--agents claude` builds a
smaller image with just one, and `--agents ''` builds none. That first build
takes several minutes and a few GB of memory; later updates rebuild it too.
The local build is named `agentbox/workspace:latest` (and the gate
`agentbox/gate:latest`) in `.env`, so a pull never replaces it.
`--agents claude,codex` (in either order) goes back to pulling. The Workbench
multiplexer `herdr` is always installed regardless. Adding a new agent is a
one-line entry in the manifest — the `case` in `images/workspace/Dockerfile`
mapping a name to its npm package — after which it becomes a valid `--agents`
value.

Each agent signs in once, inside the sandbox, the first time you run it; its
login is kept on the home volume across restarts and updates. To skip that,
set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env` and run
`sudo ./scripts/agentbox restart`.

### Isolating the sandbox from the host

On a **shared** host — one that also runs other services, a management UI or a
deploy mechanism — pass `--isolate-host`. It reads the stack's Docker subnet,
renders the nftables egress rules from [the security model](security.md#isolating-the-sandbox-from-the-host)
against it, installs them to `/etc/nftables/agentbox-egress.nft`, writes and
enables the `agentbox-egress` systemd unit so they survive a reboot, and then
proves from inside a container that a port actually listening on the host is
refused while the public internet still answers (if nothing on the host is
listening it says the isolation is applied but not proven). Re-running it
replaces the rules rather than stacking them. It needs root (for `nft` and `systemd`) and declines on
a rootless host, where a breakout lands in a user account and the isolation is
not needed. A single-purpose host with nothing else on it does not need it
either.

### DNS

DNS is the one thing the installer cannot do for a third-party provider. In
standalone and traefik modes it prints the exact record to add — name, type,
value, and whether to proxy it — then polls until the hostname resolves, so you
get a green check rather than guessing.

### Hostnames to point at the server

One: `code.example.com`, which serves everything — the sign-in, the editor, the
Workbench, the terminals. Standalone mode obtains its certificate on the first
request.

## Signing in

Every request goes through the **gate**, a small container outside the sandbox
that holds the password, sessions, two-factor and device tokens; the sandbox
can neither read nor change any of it. Any page you open without a session
sends you to `/login`, which asks for the username and password — and a
six-digit code once two-factor is on — and then returns you where you were
going. Tick **Remember this device** to stay signed in for 30 days; otherwise a
session ends after 12 hours unused. You land on **Home**; every surface is
described in [the app](workbench.md). Settings → Account lists your sessions
and ends any of them.

**Changing the password.** `sudo ./scripts/agentbox passwd` prompts for a new one
(leave it blank to generate one) and signs every session out. The gate's store
is what counts: `AGENTBOX_PASSWORD_HASH` in `.env` only seeds a store that does
not exist yet, so editing it by hand changes nothing — `passwd` updates it too,
so the two never disagree.

**Asked again, every time.** Approving a device, two-factor changes, the
password and revoking a device token ask for your password (and a code, with
two-factor on) each time, in the same request — a signed-in session alone is
never enough for them, however recently you signed in. Everything else never
asks.

**Two-factor.** Optional, and recommended on a box reachable from the internet.
**Settings → Account → Two-factor → Turn on**: enter your password, scan the
QR code with an authenticator app (or type the secret shown under it), and
enter the six-digit code it shows. You are then given ten recovery codes —
copy or download them before closing the dialog; each signs you in once in
place of a code. From then on the sign-in page asks for a code after the
password. Turning two-factor on or off signs every other session out. Lost
the phone and the codes? On the server:

```bash
sudo ./scripts/agentbox totp reset     # two-factor off, every session signed out
```

**Too many attempts.** Sign-in allows five password checks a minute from one
address, slows down after five failures in a row, and after ten locks that
address out for 15 minutes. The page says how long to wait. To clear it early:

```bash
sudo ./scripts/agentbox gate unlock
```

**Devices.** The command-line client, installed on your own machine with
`curl -fsSL https://<your box>/cli/install | sh` (see [docs/cli.md](cli.md)),
signs in without your password: it shows a code and opens
`/settings/devices?code=…`, where you approve it while signed in. It then holds
a token of its own, which you can revoke. Signing in also makes `ssh <box>`
work from that machine, through the gate with that token: the box runs an SSH
endpoint that publishes no port (see [SSH](cli.md#ssh-the-box-as-a-host)). To
end every session and revoke every device token at once — a lost laptop, say:

```bash
sudo ./scripts/agentbox gate revoke-all
```

**Sharing apps.** Every app has its own address, `/a/<id>/`, open to you
alone until you share it from the Preview panel: to anyone with the link, or
with a passcode, until a time you choose or until you stop. Who may open an app
is decided by the gate, outside the sandbox, so an agent cannot make one public;
`--sharing off` turns sharing off for the box. See [apps](workbench.md#apps)
and [the security model](security.md#apps).

## If something already serves ports 80 and 443

Most VPSes running other workloads already have nginx, Traefik or Caddy on those
ports. Use behind-proxy mode, which binds loopback only:

```bash
sudo bash install.sh --mode behind-proxy --bind 127.0.0.1:8443
```

Then forward to `127.0.0.1:8443` from your existing proxy. Authentication still
happens inside agentbox, so the sandbox is not exposed even to other local
services that guess the port. Two things your proxy must do:

- **Pass the original `Host` header** (nginx: `proxy_set_header Host $host;`),
  and pass WebSocket upgrades. The gate and the services behind it compare a
  request's `Origin` with its `Host`; a rewritten `Host` refuses every sign-in
  and every terminal.
- **Say who the visitor is, in `X-Forwarded-For`.** To agentbox every request
  arrives from your proxy, so Caddy trusts it (it connects from a private
  address) and reads the visitor from `X-Forwarded-For`, walking from the right
  past private addresses. nginx: `proxy_set_header X-Forwarded-For
  $proxy_add_x_forwarded_for;`. cloudflared sets it by itself; behind a
  Cloudflare Tunnel or an orange-cloud record, also pass `--cloudflare on`, so
  Cloudflare's addresses are skipped too. Without this, sign-in limits count
  every visitor as one, and one visitor's failures can lock everyone out.
  (A proxy that writes the visitor's address into a header of its own, such
  as nginx's `X-Real-IP`, can have Caddy read that first instead:
  `--real-ip-header X-Real-IP`. Your proxy must then **overwrite** that header
  on every request — nginx: `proxy_set_header X-Real-IP $remote_addr;` —
  because one it passes through from the visitor is the visitor's to forge.
  It is never `CF-Connecting-IP`, which is `--cloudflare on`, or
  `X-Forwarded-For`, which is always read; the installer refuses both.)

The box must be reached over HTTPS (or on `localhost`): the session cookie is
`Secure`, and a browser will not keep it over plain HTTP.

### Behind a Cloudflare Tunnel

If the server is already reachable through a Cloudflare Tunnel, install in
behind-proxy mode with `--cloudflare on` and add a published application route
pointing at the bind address. No port is opened, and Cloudflare terminates TLS:

```
code.example.com  →  http://127.0.0.1:8443
```

**Order matters.** `cloudflared` matches ingress rules top to bottom, so a
route placed below a wildcard such as `*.example.com` never runs. The symptom
is confusing: the hostname answers, but with whatever the wildcard points at,
so you get a `200` from the wrong service rather than an obvious error. Move
the specific hostname above the wildcard (row menu → **Move up**), and confirm
with the connector's own log, which prints the resolved ingress list.

## Rootless Docker

Running the daemon as an unprivileged user means a container escape lands in a
normal user account instead of root. Recommended on shared hosts:

```bash
curl -fsSL https://get.docker.com/rootless | sh
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
bash install.sh --mode behind-proxy
```

Ports below 1024 are unavailable to a rootless daemon, which is another reason
to prefer behind-proxy mode there.

## Day to day

In the install folder (for a `~/agentbox` install made without `sudo`, drop
the `sudo`):

```bash
cd /opt/agentbox
sudo ./scripts/agentbox status
sudo ./scripts/agentbox restart         # the whole stack, in order
sudo ./scripts/agentbox logs code
sudo ./scripts/agentbox workbench       # the Workbench bridge's log
sudo ./scripts/agentbox logs gate       # sign-ins, lockouts, admin commands
sudo ./scripts/agentbox passwd          # change the password (signs everyone out)
sudo ./scripts/agentbox totp reset      # turn two-factor off
sudo ./scripts/agentbox gate status     # what the gate has: two-factor, sessions, tokens
sudo ./scripts/agentbox backup          # archive your work
sudo ./scripts/agentbox update
```

The terminals, the shell, the SSH endpoint, the monitor and the Workbench
share the editor container's network. If Docker restarts the `code` container
on its own (after a crash, say), those five lose their network and the box
answers 502 until they rejoin it; `sudo ./scripts/agentbox restart` brings them
back in the right order.

## Updating

```bash
cd /opt/agentbox
sudo ./scripts/agentbox update                    # the latest release
sudo ./scripts/agentbox update --version v1.2.0   # a particular one, older or newer
```

`update` downloads the release bundle, checks it against the release's
`SHA256SUMS`, unpacks it over the install folder, sets `AGENTBOX_TAG` to the
new release, pulls its images and restarts. `.env` is kept as it is. Your
workspace and home volumes are untouched, so files, agent logins and editor
settings survive. A box that builds its own images (other `--agents`, or
`--build`) rebuilds them from the new release's sources instead of pulling.
`sudo ./scripts/agentbox apply` pulls (or builds) and restarts without changing the
release, for after you edit `.env` by hand.

Releases are listed at
[github.com/jabezpauls/agentbox/releases](https://github.com/jabezpauls/agentbox/releases).
`AGENTBOX_RELEASE_URL` and `AGENTBOX_IMAGE_PREFIX`, set in the environment of
the first install, point the box at a mirror of the releases and the images;
both are kept in `.env`.

### Installs from before releases

A box installed with `git clone` (every box before the first release) keeps
working as it did: `update` sees the `.git` folder, pulls and rebuilds. To move
it onto releases, in place, keeping `.env` and every volume:

```bash
cd ~/agentbox                                 # wherever it was cloned; it stays there
./scripts/agentbox update                     # once more the old way, for the new scripts
mv .git ../agentbox-git-backup                # no longer a clone
./scripts/agentbox update --version latest    # onto releases: pulls from now on
```

(Those installs ran as the user who cloned them, so no `sudo`; if yours was
installed as root, prefix each command with `sudo`.)

A folder that is neither a release nor a clone, copied over by hand, is left
alone by `update`, which says so. `sudo ./scripts/agentbox update --version latest`
moves it onto releases, keeping its `.env`. If such a box builds its own images
under local names, keep `AGENTBOX_WORKSPACE_IMAGE=agentbox/workspace:latest`
and `AGENTBOX_GATE_IMAGE=agentbox/gate:latest` (and `AGENTBOX_BUILD=on`) in its
`.env`, and the compose files use those names rather than pulling.

### From a clone

Running `install.sh` from inside a clone of the repository installs that
clone, and builds the images from it rather than pulling:

```bash
git clone https://github.com/jabezpauls/agentbox.git && cd agentbox
sudo bash install.sh --domain code.example.com
```

`install.sh --from-git` does the clone for you. `update` in a clone runs
`git pull` and rebuilds; check out a tag first to stay on a release.

Global npm packages an agent installs go to `~/.npm-global` and npm's cache
to `~/.npm-cache`, both on the home volume. A home volume from an older image
may have `~/.npm` owned by root, which made `npm create` and `npx` fail with
`EACCES`; npm no longer uses it, so it can stay.

A plain update does not rewrite `.env`. When an update adds settings, an
existing install keeps its old file and the new keys are simply absent — compare
it against `.env.example` after updating and copy across anything missing.

To adopt a setting on an existing box, pass the install flag to `update`, which
writes the matching `.env` key and re-applies it: `agentbox update --agents
claude` builds with just Claude, `agentbox update --mode traefik` swaps the
overlay, `agentbox update --tls passthrough` swaps it for
[direct TLS](#direct-tls-passthrough), and `--cloudflare`, `--real-ip-header`,
`--isolate-host`, `--cert-resolver`,
`--edge-network`, `--cpus`, `--memory`, `--proxy-cpus`, `--proxy-memory`,
`--build` and `--no-build` all work the same way. `update`
checks every flag before it writes any of them.

Updating a box from before the gate existed brings in the gate, which seeds its
store from the password hash already in `.env` — the same password signs in —
and the proxy stops authenticating. What changes for you:

- The first visit shows the sign-in page instead of the browser's password
  popup. A browser may keep sending the old popup's credentials for a while;
  they are ignored, and never reach the sandbox.
- The editor moved from `/` to `/vscode/`.
- Public `/s/<token>` links stop opening, and per-port preview hostnames are
  gone: apps (`/a/<id>/`) replace both, and are shared from the Preview panel.
  `AGENTBOX_PREVIEW_DOMAIN` can be deleted from `.env`; the wildcard DNS
  record and any route for it on a fronting proxy can go too. The old
  `AGENTBOX_PREVIEW_MODE` becomes `AGENTBOX_SHARING` on the next update.
- Whose address sign-in limits count is now worked out by Caddy (see
  [behind-proxy](#if-something-already-serves-ports-80-and-443) and
  [traefik mode](#traefik-mode)), and the new `AGENTBOX_CLOUDFLARE` setting
  replaces what `AGENTBOX_CLIENT_IP_HEADER` used to do. A re-run of the
  installer, or `agentbox update`, derives it from the old key: an `.env` naming
  `CF-Connecting-IP` there becomes `--cloudflare on`, anything else `off`, and
  a traefik install that never set it `on`, as it always assumed. Check it
  with `grep CLOUDFLARE .env`; change it with `agentbox update --cloudflare on|off`.
  The old key itself is then removed; a header other than `CF-Connecting-IP`
  or `X-Forwarded-For` moves to `AGENTBOX_REAL_IP_HEADER` (see
  [behind-proxy](#if-something-already-serves-ports-80-and-443)). Caddy never
  reads the old key, so the first update, run by the script from before this
  change, starts cleanly with it still in `.env`; the next `agentbox update`
  tidies it away.
- `sudo ./scripts/agentbox backup` now includes the gate's volume (the password
  hash, sessions, two-factor, device tokens). Keep the archive as private as
  `.env`.

Review replaced the bundled lavish-axi, so `AGENTBOX_LAVISH_DOMAIN` and
`AGENTBOX_LAVISH_URL` no longer do anything and can be deleted from an existing
`.env`; leaving them there is harmless. The `lavish.<domain>` DNS record and
its route on any fronting proxy can go as well. The optional key that replaces
them is `AGENTBOX_PUBLIC_URL`, the origin you browse to, which is used only so
`agentbox-review open` can print a link worth clicking.
