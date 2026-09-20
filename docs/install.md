# Installing

## One command

```bash
curl -fsSL https://raw.githubusercontent.com/jabezpauls/agentbox/main/install.sh \
  | bash -s -- --domain code.example.com
```

Point `code.example.com` at the server first; the certificate is issued on your
first visit. The installer prints a generated password once.

## If something already serves ports 80 and 443

Most VPSes running other workloads already have nginx, Traefik or Caddy on those
ports. Use behind-proxy mode, which binds loopback only:

```bash
curl -fsSL .../install.sh | bash -s -- --mode behind-proxy --bind 127.0.0.1:8443
```

Then forward to `127.0.0.1:8443` from your existing proxy. Authentication still
happens inside agentbox, so the sandbox is not exposed even to other local
services that guess the port.

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
./scripts/agentbox password        # rotate the login
./scripts/agentbox backup          # archive your work
./scripts/agentbox update
```

## Updating

`./scripts/agentbox update` pulls, rebuilds and restarts. Your workspace and
home volumes are untouched, so files, agent logins and editor settings survive.
