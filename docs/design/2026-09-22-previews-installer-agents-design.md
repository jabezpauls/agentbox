# Previews, sharing, installer and agent selection

Status: approved design, September 2026. Builds on the deployed agentbox +
Workbench + Review stack. Implement as one phase after the `hardening` branch
merges, since it touches the preview code that branch is changing.

## Why

Four things surfaced from running the real deployment:

1. A preview whose target isn't serving shows a raw Cloudflare 502, not an
   in-app message.
2. Everything that made the deployment work — Traefik mode, host-egress
   isolation, resource caps — was done by hand and isn't in the installer.
3. The image always installs the same coding agents; the operator can't choose.
4. Previews are viewable only behind the login. There's no way to share one,
   and per-port subdomains would need a wildcard certificate the zone can't
   easily provide.

## 1. Preview fallback

The bridge preview proxy must never surface a raw upstream failure.

- On `ECONNREFUSED` / connect timeout / read timeout / a 5xx from a server that
  is clearly not up, the proxy returns its **own** `200` HTML page in the
  Workbench visual language: a title ("Nothing is serving on port N" for a
  refused connection, "Port N returned an error" for a 5xx), a line of
  explanation, and a Retry button that reloads the frame. Never a bare status
  that Cloudflare or the browser will render as their own error page.
- The panel probes the port (`HEAD` through the same proxy) before mounting the
  iframe and shows an in-app state — checking, not responding, ready — so the
  common "not up yet" case is a calm message, not a flash of an error page.
- Auto-open already avoids infrastructure ports (done on `hardening`); this adds
  the graceful failure for the ports it does open.

## 2. Installer

`install.sh` gains flags for everything the deployment needed, and an
interactive path when run without them. Each flag also works through
`agentbox update` so an existing install can adopt them.

| Flag | Effect |
| --- | --- |
| `--mode traefik` | The no-published-port overlay; implies the edge network |
| `--edge-network <name>` | External Traefik network (default `edge-prod`) |
| `--cert-resolver <name>` | Traefik cert resolver (default `letsencrypt`) |
| `--isolate-host` | Write the nftables egress rules and the `agentbox-egress` systemd unit for this stack's subnet, and enable it |
| `--proxy-cpus` / `--proxy-memory` | Proxy caps (default 1 / 256m) |
| `--agents <list>` | Which coding agents to build into the image (item 3) |
| `--preview <off\|path>` | Preview mode (item 4); `path` enables sharing |

- `--isolate-host` is the manual firewall work, packaged: it reads the stack's
  Docker subnet, renders the `docs/security.md` nftables template against it,
  installs it to `/etc/nftables/agentbox-egress.nft`, writes and enables the
  systemd unit, and verifies from inside a container that a host service is
  refused while a public host answers. It refuses to run on a rootless or
  single-purpose host where it isn't needed, and says why.
- DNS stays the one thing the installer cannot do for a third-party provider.
  It prints the exact record to add (name, type, value, proxied) and then
  polls until the hostname resolves to the host, so the operator gets a green
  check rather than guessing.
- Interactive mode asks the same questions the flags answer, with the safe
  default preselected, and prints the resolved command it will run before
  running it.

## 3. Agent selection

The agents installed into the sandbox image become a build-time choice.

- The Dockerfile takes `AGENTS` (a comma list) instead of the boolean
  `INSTALL_AGENTS`. A small manifest maps each name to its install step:
  `claude` → `@anthropic-ai/claude-code`, `codex` → `@openai/codex`, and room
  for more without touching the build logic.
- `install.sh --agents claude,codex` passes it as `--build-arg`. Interactive
  mode shows a checklist. Default is the current pair.
- `herdr` is always installed regardless — it is the multiplexer Workbench and
  the TUI both attach to, not an optional agent.
- Documented so adding an agent is a one-line manifest entry.

## 4. Path-based previews and sharing

One hostname, no wildcard certificate, opt-in public sharing.

### Private preview (unchanged in spirit)

`/workbench/preview/<port>/` behind the proxy's auth, for the owner's own
viewing. Sandboxed, credentials stripped, as today.

### Sharing

A share is an explicit act on a port.

- **Mint:** `POST /api/preview/shares { port }` → `{ id, token, url, expires }`.
  The token is 128 bits from a CSPRNG. The record — token, port, created,
  expires (default 24h), revoked — lives in the bridge, persisted under the
  home volume so it survives a restart.
- **Serve:** Caddy serves a dedicated path prefix **without** basic auth:

  ```
  handle /s/* {
      reverse_proxy workbench-bridge
  }
  ```

  The bridge resolves `/s/<token>/<path>` to the port and proxies to
  `127.0.0.1:<port>`, exactly like the private preview but keyed by token
  rather than port-in-path. An unknown, expired, or revoked token is a plain
  `404` — a share link reveals nothing about what else exists.
- **List / revoke:** `GET /api/preview/shares`, `DELETE /api/preview/shares/:id`.
  Revoke takes effect immediately. Expired shares are pruned like review
  sessions.

### The panel

- Each port row gets a **Share** action. Sharing shows the link, a copy button,
  the expiry, an Extend and a Revoke, and a persistent banner: "Public — anyone
  with this link can view this. Revoke when you're done." A shared port is
  marked in the list so it's never ambiguous which ports are public.
- Full-screen open of a shared preview uses the `/s/<token>/` URL, so the shared
  thing and what the owner sees are the same.

### Security model (the sensitive part, stated plainly)

- **Never public by default.** A port is private until the owner mints a share.
- **Unguessable + revocable + expiring.** 128-bit token, instant revoke, 24h
  default expiry the owner can extend.
- **The `/s/` path is rate-limited** the way the login is, and serves only the
  mapped port — it is not a general proxy.
- **It is the owner's own app being exposed**, by their choice. The sandbox's
  own isolation (no host, no other stacks) is unchanged; sharing exposes a
  workspace dev server, not the box.
- The panel never lets a share exist without the "this is public" banner
  visible, so a public preview is never a surprise.

## Testing

- Fallback: proxy to a refused port → branded page, not a 5xx the edge renders;
  proxy to a 5xx upstream → branded page; a real server still renders.
- Installer: `--mode traefik --isolate-host --agents claude` renders valid
  compose, a valid nftables file for the detected subnet, and an image built
  with only the chosen agent; the DNS step polls and reports.
- Agent selection: `AGENTS=claude` builds an image with claude and not codex,
  and vice versa; `herdr` present in both.
- Sharing: mint → the `/s/<token>/` URL serves the port with no auth; revoke →
  404; expiry → 404; an unknown token → 404; the private path still needs auth;
  the share store survives a restart and prunes expired entries.
- e2e: start a server in a pane, share it, fetch the share URL without
  credentials and get the page, revoke it and get 404.
