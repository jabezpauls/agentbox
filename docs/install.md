# Installing

## One command

```bash
curl -fsSL https://raw.githubusercontent.com/jabezpauls/agentbox/main/install.sh \
  | bash -s -- --domain code.example.com
```

Point `code.example.com` at the server first; the certificate is issued on your
first visit. The installer prints a generated password once; sign in with it at
`https://code.example.com/login` (any page sends you there).

## Options

Run `install.sh` with **no options** for an interactive walk-through: it asks
the same questions the flags answer, with the safe default preselected, and
prints the resolved command before it runs anything.

| Flag | Default | What it does |
| --- | --- | --- |
| `--domain <host>` | — | The hostname you browse to. Required in standalone and traefik modes. |
| `--mode <mode>` | `standalone` | `standalone` owns :80/:443 and gets its own certificate; `behind-proxy` binds loopback only; `traefik` publishes no port and lets a container Traefik route to it. |
| `--bind <addr:port>` | `127.0.0.1:8443` | behind-proxy listen address. |
| `--edge-network <name>` | `edge-prod` | traefik: the external network your Traefik already watches. |
| `--cert-resolver <name>` | `letsencrypt` | traefik: the Traefik certificate resolver for this host. |
| `--user` / `--password` | `admin` / generated | The sign-in. Only a bcrypt hash is stored, in the gate. On an existing install, `--password` replaces the current password and signs every session out. |
| `--preview <off\|path>` | `path` | Kept so older commands still run. Public `/s/<token>` shares are off; see [Signing in](#signing-in). |
| `--cloudflare <on\|off>` | `on` in traefik mode, else `off` | The hostname is proxied through Cloudflare (or reached through a Cloudflare Tunnel). Decides whose address sign-in limits count; see below. |
| `--agents <list>` | `claude,codex` | Which coding agents to build into the image, comma-separated (`claude`, `codex`). `herdr` is always installed. |
| `--isolate-host` | off | Firewall the sandbox off the host and other private networks — see below. |
| `--cpus` / `--memory` | `2` / `4g` | Sandbox ceilings per service. |
| `--proxy-cpus` / `--proxy-memory` | `1` / `256m` | Proxy container ceilings. |
| `--dir <path>` | `~/agentbox` | Where to install. |
| `--yes` | — | Do not prompt. |

Re-running the installer keeps every setting you already have — mode, domain,
caps, API keys, anything you added to `.env` by hand — and changes only the
ones you pass. `install.sh --isolate-host` on an existing traefik box adds the
firewall and leaves it a traefik box. The password is kept unless you pass
`--password`. `--preview-domain` is still accepted, and ignored with a warning:
per-port preview hostnames were removed.

### traefik mode

When your reverse proxy is itself a container, prefer `traefik` mode over
`behind-proxy`: it publishes no host port at all and attaches to the external
network Traefik already watches, so nothing binds a routable host address.

```bash
curl -fsSL .../install.sh | bash -s -- \
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

### Choosing coding agents

The agents baked into the image are a build-time choice. `--agents claude,codex`
is the default; `--agents claude` builds a smaller image with just one, and
`--agents ''` builds none. The
Workbench multiplexer `herdr` is always installed regardless. Adding a new agent
is a one-line entry in the manifest — the `case` in `images/workspace/Dockerfile`
mapping a name to its npm package — after which it becomes a valid `--agents`
value.

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
session ends after 12 hours unused. The paths behind it:

| Path | What it is |
| --- | --- |
| `/vscode/` | VS Code in the browser |
| `/workbench` | The Workbench |
| `/terminal`, `/shell`, `/monitor` | herdr's TUI, a bash shell, btop |

**Changing the password.** `./scripts/agentbox passwd` prompts for a new one
(leave it blank to generate one) and signs every session out. The gate's store
is what counts: `AGENTBOX_PASSWORD_HASH` in `.env` only seeds a store that does
not exist yet, so editing it by hand changes nothing — `passwd` updates it too,
so the two never disagree.

**Sudo mode.** Approving a device, two-factor changes, the password and
revoking device tokens ask for your password again (and a code, with
two-factor on), then need nothing more for ten minutes. Everything else never
asks.

**Two-factor.** Optional, and recommended on a box reachable from the internet.
The app's Settings screen will enrol it; until your version has that screen,
use the gate's API from a signed-in tab. In the browser's developer console on
any page of the box:

```js
const post = (p, b) => fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const { secret, otpauthUrl } = await post("/_gate/totp/setup", { password: "your password" });
// Add `secret` (or `otpauthUrl`) to your authenticator app, then confirm with the code it shows:
await post("/_gate/totp/confirm", { code: "123456" });   // returns your ten recovery codes
```

Keep the ten recovery codes it returns — each signs you in once in place of a
code. Turning it on or off signs
every other session out. Lost the phone and the codes? On the server:

```bash
./scripts/agentbox totp reset     # two-factor off, every session signed out
```

**Too many attempts.** Sign-in allows five password checks a minute from one
address, slows down after five failures in a row, and after ten locks that
address out for 15 minutes. The page says how long to wait. To clear it early:

```bash
./scripts/agentbox gate unlock
```

**Devices.** The command-line client signs in without your password: it shows
a code and opens `/settings/devices?code=…`, where you approve it while signed
in. It then holds a token of its own, which you can revoke. To end every session
and revoke every device token at once — a lost laptop, say:

```bash
./scripts/agentbox gate revoke-all
```

**Public sharing is off.** The old `/s/<token>` share links and per-port preview
hostnames were decided inside the sandbox, which must not decide who gets in,
so they no longer open without a session. Sharing returns as app sharing
decided by the gate.

## If something already serves ports 80 and 443

Most VPSes running other workloads already have nginx, Traefik or Caddy on those
ports. Use behind-proxy mode, which binds loopback only:

```bash
curl -fsSL .../install.sh | bash -s -- --mode behind-proxy --bind 127.0.0.1:8443
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
  every visitor as one, and one visitor's failures can lock everyone out. (A
  proxy that sends only some other header can name it in
  `AGENTBOX_CLIENT_IP_HEADER`, which Caddy reads after `X-Forwarded-For`.)

The box must be reached over HTTPS (or on `localhost`): the session cookie is
`Secure`, and a browser will not keep it over plain HTTP.

## Rootless Docker

Running the daemon as an unprivileged user means a container escape lands in a
normal user account instead of root. Recommended on shared hosts:

```bash
curl -fsSL https://get.docker.com/rootless | sh
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
curl -fsSL .../install.sh | bash -s -- --mode behind-proxy
```

Ports below 1024 are unavailable to a rootless daemon, which is another reason
to prefer behind-proxy mode there.

## Day to day

```bash
./scripts/agentbox status
./scripts/agentbox logs code
./scripts/agentbox workbench       # the Workbench bridge's log
./scripts/agentbox logs gate       # sign-ins, lockouts, admin commands
./scripts/agentbox passwd          # change the password (signs everyone out)
./scripts/agentbox totp reset      # turn two-factor off
./scripts/agentbox gate status     # what the gate has: two-factor, sessions, tokens
./scripts/agentbox backup          # archive your work
./scripts/agentbox update
```

## Updating

`./scripts/agentbox update` pulls, rebuilds and restarts. Your workspace and
home volumes are untouched, so files, agent logins and editor settings survive.

A plain update does not rewrite `.env`. When an update adds settings, an
existing install keeps its old file and the new keys are simply absent — compare
it against `.env.example` after updating and copy across anything missing.

To adopt a setting on an existing box, pass the install flag to `update`, which
writes the matching `.env` key and re-applies it: `agentbox update --agents
claude` rebuilds with just Claude, `agentbox update --mode traefik` swaps the
overlay, and `--cloudflare`, `--isolate-host`, `--cert-resolver`,
`--edge-network`, `--cpus`, `--memory`, `--proxy-cpus` and `--proxy-memory`
all work the same way. `update`
checks every flag before it writes any of them.

Updating a box from before the gate existed builds the gate, which seeds its
store from the password hash already in `.env` — the same password signs in —
and the proxy stops authenticating. What changes for you:

- The first visit shows the sign-in page instead of the browser's password
  popup. A browser may keep sending the old popup's credentials for a while;
  they are ignored, and never reach the sandbox.
- The editor moved from `/` to `/vscode/`.
- Public `/s/<token>` links stop opening, and per-port preview hostnames are
  gone. `AGENTBOX_PREVIEW_DOMAIN` can be deleted from `.env`; the wildcard DNS
  record and any route for it on a fronting proxy can go too.
- Whose address sign-in limits count is now worked out by Caddy (see
  [behind-proxy](#if-something-already-serves-ports-80-and-443) and
  [traefik mode](#traefik-mode)), and the new `AGENTBOX_CLOUDFLARE` setting
  replaces what `AGENTBOX_CLIENT_IP_HEADER` used to do. A re-run of the
  installer, or `agentbox update`, derives it from the old key: an `.env` naming
  `CF-Connecting-IP` there becomes `--cloudflare on`, anything else `off`, and
  a traefik install that never set it `on`, as it always assumed. Check it
  with `grep CLOUDFLARE .env`; change it with `agentbox update --cloudflare on|off`.
- `./scripts/agentbox backup` now includes the gate's volume (the password
  hash, sessions, two-factor, device tokens). Keep the archive as private as
  `.env`.

Review replaced the bundled lavish-axi, so `AGENTBOX_LAVISH_DOMAIN` and
`AGENTBOX_LAVISH_URL` no longer do anything and can be deleted from an existing
`.env`; leaving them there is harmless. The `lavish.<domain>` DNS record and
its route on any fronting proxy can go as well. The optional key that replaces
them is `AGENTBOX_PUBLIC_URL`, the origin you browse to, which is used only so
`agentbox-review open` can print a link worth clicking.
