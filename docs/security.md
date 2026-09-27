# Security model

agentbox assumes the VPS it runs on may host other workloads. The sandbox is
designed so that compromising the browser-facing environment does **not** hand
over the host.

## What the sandbox cannot reach

| Boundary | How it is enforced |
| --- | --- |
| The Docker daemon | The socket is never mounted. A container with `/var/run/docker.sock` is root on the host; agentbox does not use it, and `docker compose config` will show no such mount. |
| The host filesystem | No bind mounts. `/workspace` is a named Docker volume; nothing from `/`, `/home`, or `/etc` is exposed. |
| Other stacks' data | The sandbox is on its own bridge network (`agentbox_internal`) with no route to another stack's private network, so their databases and internal services are not reachable. |
| The host itself | This is **not** automatic. `agentbox_internal` is an ordinary bridge, so by default a container can route to the host's own services (a management UI, SSH, a deploy webhook) through the bridge gateway, exactly as any Docker container can. On a shared host you must block it: see "Isolating the sandbox from the host" below. A single-purpose host with nothing else on it does not need this. |
| Privilege escalation | `no-new-privileges:true`, `cap_drop: [ALL]`, and every process runs as UID 1000, never root. |
| Host resources | CPU and memory ceilings per service, plus a PID limit, so a runaway agent cannot starve the host. |

## What the sandbox *can* reach

- The public internet (outbound). Coding agents need it to reach their APIs, and
  package managers need it to install dependencies. If you want to restrict this,
  see "Egress filtering" below.
- Its own named volume, which persists across restarts and updates.
- The other sandbox services. `terminal`, `shell`, `monitor` and `workbench`
  share the `code` container's network and PID namespaces, so
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
- **A path preview is sandboxed in the panel.** Served under the Workbench's
  own origin, an agent-written page could otherwise script the app, read its
  storage and call its API as you, so the preview *iframe* deliberately omits
  `allow-same-origin`. That protection is the iframe's: opening the same
  preview full screen makes it a top-level document, where no sandbox applies
  and the page really does share the Workbench's origin. The ↗ button therefore
  warns and asks first in path mode. A configured preview domain puts the page
  on its own origin, where the browser's origin separation does the job in both
  places, and full screen opens without a prompt.
- **Previews are not handed your login.** `Authorization` and `Cookie` are
  stripped from every request and websocket upgrade the preview proxy forwards,
  so the password guarding the box never reaches a port an agent opened.
- **Public shares are opt-in, unguessable and revocable.** A preview is private
  until you mint a share for it. A share is a 128-bit CSPRNG token that the
  proxy serves under `/s/<token>/` **without** the login, so anyone you hand the
  link to can open it. It maps to exactly one loopback port and is not a general
  proxy: agentbox's own services (the editor, the ttyd shells, the bridge) can
  never be shared, at mint or at serve. An unknown, expired (24h default) or
  revoked token is a plain `404` that reveals nothing else exists; revoking —
  or expiry — also cuts any connection a viewer already has open. Turn the
  whole feature off with `--preview off`. Records live under
  `~/.agentbox/shares/` on the home volume.
- **The unauthenticated path is decided twice, on the raw URL.** The proxy
  treats a request as public only when its raw request URI is `/s/` followed
  by a 32-hex token and contains none of the forms two parsers read
  differently — dot-segments, `%2e`, `%2f`, `%5c`, a backslash, `;`, `//`.
  Anything else takes the login. The proxy deletes any client-sent
  `X-Agentbox-Public` header on every request and sets it only on that public
  branch, and the bridge refuses (404) any request carrying it whose raw path
  is not a share. Because the bridge judges the same raw string it routes on,
  a normalisation difference between Caddy and the bridge cannot turn a public
  request into a private route. The bridge also refuses (400) those ambiguous
  forms in any path it routes, checking only the routing prefix of a preview
  or share so an app's own encoded URLs still reach it.
  `tests/proxy/share-bypass.sh` runs the real Caddyfiles against the real
  bridge with the known bypass shapes.
- **A shared page does not get the box's origin.** It is served on the box's
  hostname, so every response under `/s/` carries
  `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups
  allow-modals`: the browser gives it an opaque origin — no access to the
  Workbench's cookies, storage, API or credentials — even when it is opened as
  a top-level tab. `Service-Worker-Allowed` is stripped from every proxied
  response, so a previewed page cannot register a worker over the Workbench.
  What a share *does* expose is your app itself, to anyone with the link: its
  pages, and any endpoint it serves. Share a dev server you would be content
  for the recipient to use, and revoke it when you are done. The panel asks
  before opening a share full screen for the same reason.
- **Rate limiting of `/s/` is a traefik-mode feature.** The Traefik overlay
  gives the share path its own limit, like the login's. Caddy has no built-in
  rate limiter, so in standalone and behind-proxy modes the share path is not
  rate-limited by agentbox; the token's 128 bits are what stop guessing there,
  and a fronting proxy can add a limit. Traefik counts requests per
  `CF-Connecting-IP` by default, which is right behind Cloudflare and
  spoofable without it — set `AGENTBOX_CLIENT_IP_HEADER` empty when nothing
  fronts Traefik.
- **WebSocket upgrades are origin-checked.** The same-origin policy does not
  cover websocket handshakes, so a page in another tab could otherwise open
  `/workbench/ws/events` or `/workbench/ws/terminal` on your cached
  credentials. Every upgrade must carry an `Origin` equal to the request's own
  scheme and host; a foreign origin, a missing one and the `null` a sandboxed
  document sends are all refused.
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
for c in agentbox-code-1 agentbox-workbench-1 agentbox-terminal-1; do
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
Workbench, the terminal, the metrics or a preview. Basic authentication is
scoped per origin, so each preview hostname prompts separately with the same
credentials.

Passwords are stored only as bcrypt hashes. In `standalone` mode the proxy also
obtains and renews TLS certificates automatically.

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
