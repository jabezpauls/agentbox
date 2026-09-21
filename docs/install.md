# Installing

## One command

```bash
curl -fsSL https://raw.githubusercontent.com/jabezpauls/agentbox/main/install.sh \
  | bash -s -- --domain code.example.com
```

Point `code.example.com` at the server first; the certificate is issued on your
first visit. The installer prints a generated password once.

## Options

| Flag | Default | What it does |
| --- | --- | --- |
| `--domain <host>` | — | The hostname you browse to. Required in standalone mode. |
| `--mode <mode>` | `standalone` | `standalone` owns :80/:443 and gets its own certificate; `behind-proxy` binds loopback only. |
| `--bind <addr:port>` | `127.0.0.1:8443` | behind-proxy listen address. |
| `--user` / `--password` | `admin` / generated | The browser login. Only the bcrypt hash is stored. |
| `--preview-domain <host>` | unset | Serve each listening port at `PORT.<host>`. Needs a wildcard DNS record; see [the Workbench guide](workbench.md#previews). |
| `--cpus` / `--memory` | `2` / `4g` | Ceilings per service. |
| `--dir <path>` | `~/agentbox` | Where to install. |
| `--yes` | — | Do not prompt. |

Re-running the installer keeps your existing password unless you pass
`--password`.

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

It does not rewrite `.env`. When an update adds settings, an existing install
keeps its old file and the new keys are simply absent — compare it against
`.env.example` after updating and copy across anything missing.

Review replaced the bundled lavish-axi, so `AGENTBOX_LAVISH_DOMAIN` and
`AGENTBOX_LAVISH_URL` no longer do anything and can be deleted from an existing
`.env`; leaving them there is harmless. The `lavish.<domain>` DNS record and
its route on any fronting proxy can go as well. The optional key that replaces
them is `AGENTBOX_PUBLIC_URL`, the origin you browse to, which is used only so
`agentbox-review open` can print a link worth clicking.
