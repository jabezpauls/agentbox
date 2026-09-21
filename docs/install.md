# Installing

## One command

```bash
curl -fsSL https://raw.githubusercontent.com/jabezpauls/agentbox/main/install.sh \
  | bash -s -- --domain code.example.com
```

Point `code.example.com` at the server first; the certificate is issued on your
first visit. The installer prints a generated password once.

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
| `--user` / `--password` | `admin` / generated | The browser login. Only the bcrypt hash is stored. |
| `--preview-domain <host>` | unset | Serve each listening port at `PORT.<host>`. Needs a wildcard DNS record; see [the Workbench guide](workbench.md#previews). |
| `--preview <off\|path>` | `path` | Public preview sharing under `/s/<token>`. `off` disables minting and serving shares and hides the Share action. |
| `--agents <list>` | `claude,codex` | Which coding agents to build into the image, comma-separated (`claude`, `codex`). `herdr` is always installed. |
| `--isolate-host` | off | Firewall the sandbox off the host and other private networks — see below. |
| `--cpus` / `--memory` | `2` / `4g` | Sandbox ceilings per service. |
| `--proxy-cpus` / `--proxy-memory` | `1` / `256m` | Proxy container ceilings. |
| `--dir <path>` | `~/agentbox` | Where to install. |
| `--yes` | — | Do not prompt. |

Re-running the installer keeps your existing password unless you pass
`--password`.

### traefik mode

When your reverse proxy is itself a container, prefer `traefik` mode over
`behind-proxy`: it publishes no host port at all and attaches to the external
network Traefik already watches, so nothing binds a routable host address.

```bash
curl -fsSL .../install.sh | bash -s -- \
  --mode traefik --domain code.example.com \
  --edge-network edge-prod --cert-resolver letsencrypt
```

Caddy keeps authenticating every request inside the stack, so the sandbox is
never reachable unauthenticated even from another container on that network.

### Choosing coding agents

The agents baked into the image are a build-time choice. `--agents claude,codex`
is the default; `--agents claude` builds a smaller image with just one. The
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
proves from inside a container that the host is refused while the public
internet still answers. It needs root (for `nft` and `systemd`) and declines on
a rootless host, where a breakout lands in a user account and the isolation is
not needed. A single-purpose host with nothing else on it does not need it
either.

### DNS

DNS is the one thing the installer cannot do for a third-party provider. In
standalone and traefik modes it prints the exact record to add — name, type,
value, and whether to proxy it — then polls until the hostname resolves, so you
get a green check rather than guessing.

### Hostnames to point at the server

Standalone mode obtains a certificate for each of these on first request:

- `code.example.com` — the editor, the Workbench, the terminal, the monitor
- `*.preview.example.com` — only if you set `--preview-domain`, and only with a
  wildcard DNS record

## If something already serves ports 80 and 443

Most VPSes running other workloads already have nginx, Traefik or Caddy on those
ports. Use behind-proxy mode, which binds loopback only:

```bash
curl -fsSL .../install.sh | bash -s -- --mode behind-proxy --bind 127.0.0.1:8443
```

Then forward to `127.0.0.1:8443` from your existing proxy. Authentication still
happens inside agentbox, so the sandbox is not exposed even to other local
services that guess the port.

Forward the preview wildcard too, if you configured one: agentbox routes it
apart by `Host`. Your proxy owns the certificate for that name in this mode.

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
./scripts/agentbox password        # rotate the login
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
claude` rebuilds with just Claude, `agentbox update --preview off` turns sharing
off, `agentbox update --mode traefik` swaps the overlay, and `--isolate-host`,
`--preview-domain`, `--cert-resolver`, `--edge-network`, `--cpus`, `--memory`,
`--proxy-cpus` and `--proxy-memory` all work the same way.

Review replaced the bundled lavish-axi, so `AGENTBOX_LAVISH_DOMAIN` and
`AGENTBOX_LAVISH_URL` no longer do anything and can be deleted from an existing
`.env`; leaving them there is harmless. The `lavish.<domain>` DNS record and
its route on any fronting proxy can go as well. The optional key that replaces
them is `AGENTBOX_PUBLIC_URL`, the origin you browse to, which is used only so
`agentbox-review open` can print a link worth clicking.
