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
- The gate's listener, on the internal network, exactly as an anonymous visitor
  would: the sign-in page, rate-limited sign-in, and nothing else. It is keyed
  on its own address there and cannot claim another, and it cannot read or
  write the gate's store. It cannot reach the proxy at all.

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
  one branch to another. Then, on the raw path: `/login` and the gate's own
  `/_gate/*` API, `/cli/*` (the CLI download, empty until it ships) and the
  device-approval page stay in the gate; `/vscode/*` goes to code-server with
  the prefix stripped; `/terminal`, `/shell` and `/monitor` go to their ttyd
  services unchanged; everything else goes to the bridge unchanged.
- **Nothing without a session or a device token.** A page load without one is
  sent to `/login?next=<where it was going>`; any other request gets `401`. The
  only routes open without one are the sign-in page and its assets, sign-in
  itself, the two calls a device login makes (below) and the CLI download. A
  request from the sandbox to the gate is treated as any anonymous client.
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
- **Sudo mode.** What would let someone keep the box or lock you out needs
  fresh credentials, not just the session: approving a device, setting up,
  confirming or turning off two-factor, changing the password, and revoking
  device tokens. Re-entering the password — and a code, with two-factor on —
  puts the session in sudo mode for ten minutes (`POST /_gate/sudo`, or the
  credentials sent with the request itself, which are always checked). The
  approval page asks for them in the same form. Ordinary use never asks.
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
  sign-in, sudo mode and the password change all count; from the fifth
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
  read only when every hop was trusted. Caddy writes the answer into
  `X-Agentbox-Client-IP`, dropping any copy a client sent, and the gate
  believes that header only on connections from the proxy — named `proxy` in
  compose, resolved in the background, and on a network the sandbox is not
  on. A request that reaches Traefik directly with forged headers is keyed on
  the address Traefik appends for it; one that calls the gate from the sandbox
  is keyed on its own. Residual: a client that itself has a private address —
  another container on a shared edge network, a machine on the host's LAN —
  can write what it likes further left in `X-Forwarded-For` and pick its own
  budget. It still meets the global ceiling, and it still needs the password.
- **Two-factor (optional).** TOTP (RFC 6238: SHA-1, six digits, 30-second
  steps, one step of clock drift either way), each code usable once. Enrolling
  gives ten single-use recovery codes of 80 bits each, stored as SHA-256
  digests. A lost phone is fixed on the host with `./scripts/agentbox totp
  reset`.
- **Device tokens.** The CLI signs in with a device flow: it asks the gate for a
  code, the owner — signed in, in a browser, in sudo mode — approves it on
  `/settings/devices?code=XXXX-XXXX`, and the CLI collects a token once. One
  client address may have three logins waiting, and a hundred may wait in
  all. Tokens are `abx_` plus 256 random bits, stored as SHA-256 digests with a
  name, when they were made and last used, and from where; they work as
  `Authorization: Bearer` on every authenticated route, ttyd included. They
  cannot manage the account — sessions, the password, two-factor, approving
  another device — which takes a signed-in browser, and a token may revoke
  only itself. Revoke others from a browser in sudo mode, or all of them with
  `./scripts/agentbox gate revoke-all`.
- **Headers.** Everything the gate serves carries `X-Content-Type-Options:
  nosniff` and — except its own pages, above — `Referrer-Policy: no-referrer`,
  and HTML carries `frame-ancestors 'self'`. The sign-in pages allow nothing
  but their own files (`default-src 'none'`). HSTS stays with whatever
  terminates TLS.
- **The host's escape hatches** (`passwd`, `totp reset`, `gate unlock`,
  `gate revoke-all`) reach the running gate through a Unix socket in the gate
  container's private `/tmp`, so only a process already inside that container
  — `docker compose exec` from the host — can use them. With the gate stopped
  they edit the store directly, and refuse while any gate holds its lease on
  the volume.

### What a compromised sandbox can still do

The box's one origin also serves what the sandbox controls: code-server, the
ttyd shells and the bridge's app are all programs inside it. So a compromised
sandbox can run script in your browser, on the box's origin, while you have a
tab of it open — and that script acts with your session, and could show a
lookalike prompt and read a password typed into it while it runs. With
internet egress it can also publish itself through a tunnel of its own; that
was always true (see "Egress filtering").

What the gate guarantees regardless:

- nothing reaches the sandbox without a session or a device token;
- no front-door credential — the password, the session cookie, a token — is
  ever sent into the sandbox;
- no persistent takeover: no service worker outside the editor, so nothing the
  sandbox serves outlives the tab or answers for the gate's pages;
- app content runs without the box's origin in the preview panel (a sandboxed
  frame). Opened full screen, a path preview does run on the box's origin — the
  panel warns and asks first — until the app model, which serves every app
  under an opaque origin, replaces path previews;
- the changes that would keep the box or lock you out — a new device, the
  password, two-factor, revoking tokens — need the password again (and a code,
  with two-factor on), not just the session.

`tests/proxy/gate-bypass.sh` runs the real Caddyfiles and the real gate image,
wired as compose wires them, against stand-ins for every sandbox port, a real
Traefik and a stand-in Cloudflare edge, and proves the first three.

## The Workbench's own surface

- **The bridge is not published.** `workbench` listens on :7800 inside the
  shared namespace. Only the gate forwards to it, and only once a request is
  authenticated.
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
  warns and asks first.
- **Previews are not handed your login.** The gate has already removed its own
  cookies and `Authorization` from every request; the bridge's preview proxy
  strips `Cookie` and `Authorization` again from everything it forwards to a
  port an agent opened.
- **Public shares are off.** The old `/s/<token>/` links were served without a
  login on the strength of a record the bridge kept — inside the sandbox, where
  an agent could have minted one for any port. That breaks the first rule, so
  the gate admits no one without a session, and the bridge runs with sharing
  off. Per-port preview hostnames are gone as well: the session cookie is
  host-only and never reaches another hostname. Sharing returns as app sharing
  decided by the gate.
- **The bridge still guards its own paths.** It refuses (400) the same
  ambiguous path forms the gate does, in any path it routes (checking only the
  routing prefix of a preview, so an app's own encoded URLs still reach it), and
  `Service-Worker-Allowed` is stripped from every proxied response, so a
  previewed page cannot register a worker over the Workbench.
- **WebSocket upgrades are origin-checked, twice.** The same-origin policy does
  not cover websocket handshakes, so a page in another tab could otherwise open
  `/workbench/ws/events` or `/workbench/ws/terminal` on your session cookie.
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
