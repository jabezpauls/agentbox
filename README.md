# agentbox

A sandboxed coding environment for a VPS, reachable from any browser.

Editor, terminal, process monitor and your coding agents — behind a login, in
containers that cannot reach the host.

```bash
curl -fsSL https://raw.githubusercontent.com/jabezpauls/agentbox/main/install.sh \
  | bash -s -- --domain code.example.com
```

That installs Docker if it is missing, generates a password, obtains a TLS
certificate and starts the stack. It prints the password once.

## What you get

| Path | What it is |
| --- | --- |
| `/` | VS Code in the browser — files, editor, integrated terminal, extensions |
| `/terminal` | A full-screen shell, pleasant on a phone |
| `/monitor` | Live CPU, memory and process usage for the sandbox |

## Coding agents

[Claude Code](https://github.com/anthropics/claude-code) and
[Codex](https://github.com/openai/codex) are installed and on the `PATH`. Run
them from the editor's integrated terminal, or full-screen at `/terminal`.

Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env` to skip the interactive
login. Otherwise sign in once inside the sandbox; credentials persist in a
volume across restarts and updates.

Build without them if you prefer a plain environment:

```yaml
# docker-compose.override.yml
services:
  code:
    build:
      args:
        INSTALL_AGENTS: "false"
```

## The sandbox boundary

This is the point of the project, so it is enforced rather than asserted:

- **No Docker socket.** Mounting it would make the container root on the host.
- **No host bind mounts in the sandbox.** `/workspace` is a named volume; `/`,
  `/home` and `/etc` are not visible. The proxy — a separate container, not the
  sandbox — mounts only its own config file, read-only.
- **No privileges.** Every process runs as UID 1000 with all capabilities
  dropped and `no-new-privileges` set.
- **Bounded.** CPU, memory and PID ceilings stop a runaway agent from taking
  the host down with it.
- **One door.** Only the proxy publishes a port, and it authenticates first.

It protects the host from the sandbox. It does not make the code inside safe:
an agent with your keys can still push commits and spend tokens. See
[docs/security.md](docs/security.md) for the full threat model.

## Behind a Cloudflare Tunnel

If your server is already reachable through a Cloudflare Tunnel, use
behind-proxy mode and add a published application route pointing at the bind
address — no ports are opened and Cloudflare terminates TLS:

```
code.example.com  →  http://127.0.0.1:8443
```

**Order matters.** `cloudflared` matches ingress rules top to bottom, so a
route placed below a wildcard such as `*.example.com` never runs. The symptom
is confusing: the hostname answers, but with whatever the wildcard points at,
so you get a `200` from the wrong service rather than an obvious error. Move
the specific hostname above the wildcard (row menu → **Move up**), and confirm
with the connector's own log, which prints the resolved ingress list.

## If ports 80 and 443 are taken

Common on a VPS that already runs something. Bind to loopback and let your
existing proxy front it:

```bash
curl -fsSL .../install.sh | bash -s -- --mode behind-proxy --bind 127.0.0.1:8443
```

For the strongest isolation, run it under
[rootless Docker](docs/install.md#rootless-docker) so the daemon itself is not
root.

## Running it

```bash
./scripts/agentbox status
./scripts/agentbox logs code
./scripts/agentbox shell            # a shell inside the sandbox
./scripts/agentbox password         # rotate the login
./scripts/agentbox backup           # archive workspace and home
./scripts/agentbox update           # pull, rebuild, restart
```

## Requirements

A Linux VPS with 2 GB RAM. Docker is installed for you if absent. A domain is
needed only for standalone mode's certificate.

Allow about 5 GB of disk: the image carries VS Code, Node, a Python toolchain
and a compiler, because agents routinely install dependencies that need them.
Build without the agents (see above) or drop `build-essential` from the
Dockerfile if you want it smaller.

## Licence

MIT. See [LICENSE](LICENSE).
