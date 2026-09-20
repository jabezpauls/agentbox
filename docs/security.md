# Security model

agentbox assumes the VPS it runs on may host other workloads. The sandbox is
designed so that compromising the browser-facing environment does **not** hand
over the host.

## What the sandbox cannot reach

| Boundary | How it is enforced |
| --- | --- |
| The Docker daemon | The socket is never mounted. A container with `/var/run/docker.sock` is root on the host; agentbox does not use it, and `docker compose config` will show no such mount. |
| The host filesystem | No bind mounts. `/workspace` is a named Docker volume; nothing from `/`, `/home`, or `/etc` is exposed. |
| Other containers | A dedicated bridge network (`agentbox_internal`). Only the proxy publishes a port. |
| Privilege escalation | `no-new-privileges:true`, `cap_drop: [ALL]`, and every process runs as UID 1000, never root. |
| Host resources | CPU and memory ceilings per service, plus a PID limit, so a runaway agent cannot starve the host. |

## What the sandbox *can* reach

- The public internet (outbound). Coding agents need it to reach their APIs, and
  package managers need it to install dependencies. If you want to restrict this,
  see "Egress filtering" below.
- Its own named volume, which persists across restarts and updates.
- The other sandbox services. `terminal`, `monitor` and the Workbench services
  share the `code` container's network and PID namespaces, so `localhost` and
  the process table are common to all of them. This is deliberate: a dev server
  an agent starts in one pane is previewable from the others. The shared
  namespaces belong to sandbox containers only; nothing about the host boundary
  changes.

## Verifying the boundary yourself

Do not take the table above on trust; the claims are observable:

```bash
# No container mounts the Docker socket.
docker inspect $(docker compose ps -q) \
  --format '{{.Name}}: {{range .Mounts}}{{.Source}} {{end}}'

# The sandbox runs unprivileged with no capabilities.
docker inspect agentbox-code-1 \
  --format 'user={{.Config.User}} caps={{.HostConfig.CapDrop}} priv={{.HostConfig.Privileged}}'
```

Expect `User=1000:1000`, `CapDrop=[ALL]`, `Privileged=false`, and only
`/var/lib/docker/volumes/...` paths for the sandbox services.

## Rootless mode (recommended)

In `rootless` mode the Docker daemon itself runs as an unprivileged user, so a
container breakout lands in a user account rather than root. This is the
strongest configuration and is what the project recommends for shared hosts.

## Authentication

The proxy demands credentials before any request reaches the editor, terminal,
or metrics. Passwords are stored only as bcrypt hashes. In `standalone` mode the
proxy also obtains and renews a TLS certificate automatically.

## Threat model, honestly stated

agentbox protects the **host** from the **sandbox**. It does not make the code
you run inside the sandbox safe. An agent with your API keys, working in your
repositories, can still push commits, spend tokens, and exfiltrate anything you
place in the workspace. Treat the sandbox as a machine you trust exactly as much
as the code and agents you put in it.

## Egress filtering

Outbound traffic is unrestricted by default because agents and package managers
need it. To restrict it, attach the sandbox to an `internal: true` network and
route outbound traffic through a proxy you control. This is deliberately not the
default: it breaks most real workflows and gives a false sense of safety when
half-configured.
