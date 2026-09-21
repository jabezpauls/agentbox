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
- The other sandbox services. `terminal`, `shell`, `monitor`, `workbench` and
  `lavish` share the `code` container's network and PID namespaces, so
  `localhost` and the process table are common to all of them. This is
  deliberate: a dev server an agent starts in one pane is previewable from the
  others. The shared namespaces belong to sandbox containers only; nothing
  about the host boundary changes.

## The Workbench's own surface

- **The bridge is not published.** `workbench` listens on :7800 inside the
  shared namespace. Only the proxy can reach it, and only after authenticating.
- **The RPC forwarder is an allowlist, not a passthrough.** The browser can
  call the herdr methods the app needs and nothing else; anything outside the
  list is refused before it reaches herdr.
- **Previews only reach loopback.** `/workbench/preview/<port>/` proxies to
  `127.0.0.1:<port>` inside the sandbox, with the port validated as a number in
  range. It cannot be pointed at another host, and it reaches nothing the
  sandbox could not already reach.
- **A path preview is sandboxed.** Served under the Workbench's own origin, an
  agent-written page could otherwise script the app, read its storage and call
  its API as you, so the iframe deliberately omits `allow-same-origin`. A
  configured preview domain puts the page on its own origin instead, where the
  browser's origin separation does the same job without the restriction.
- **The directory picker is confined** to the workspace root; paths that
  escape it are rejected rather than resolved.
- **lavish binds the internal network.** lavish-axi is unauthenticated and
  serves local files, so it binds one address on `agentbox_internal` — not a
  wildcard. That network carries only agentbox's own containers, and the proxy
  is the only way in.
- **On-demand certificates are gated.** In standalone mode the preview
  wildcard's certificates are issued on demand; the permission endpoint answers
  only for numeric subdomains of the configured preview domain, comparing that
  suffix literally, so the box cannot be made to mint certificates for names it
  does not serve.

## Verifying the boundary yourself

Do not take the table above on trust; the claims are observable:

```bash
# No container mounts the Docker socket.
docker inspect $(docker compose ps -q) \
  --format '{{.Name}}: {{range .Mounts}}{{.Source}} {{end}}'

# The sandbox runs unprivileged with no capabilities.
for c in agentbox-code-1 agentbox-workbench-1 agentbox-lavish-1; do
  docker inspect "$c" \
    --format '{{.Name}} user={{.Config.User}} caps={{.HostConfig.CapDrop}} priv={{.HostConfig.Privileged}}'
done
```

Expect `User=1000:1000`, `CapDrop=[ALL]`, `Privileged=false`, and only
`/var/lib/docker/volumes/...` paths for the sandbox services.

## Rootless mode (recommended)

In `rootless` mode the Docker daemon itself runs as an unprivileged user, so a
container breakout lands in a user account rather than root. This is the
strongest configuration and is what the project recommends for shared hosts.

## Authentication

The proxy demands credentials before any request reaches the editor, the
Workbench, the terminal, the metrics, lavish or a preview. Basic authentication
is scoped per origin, so the lavish hostname and each preview hostname prompt
separately with the same credentials.

Passwords are stored only as bcrypt hashes. In `standalone` mode the proxy also
obtains and renews TLS certificates automatically.

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
