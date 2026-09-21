#!/usr/bin/env bash
# agentbox installer.
#
#   curl -fsSL https://raw.githubusercontent.com/jabezpauls/agentbox/main/install.sh \
#     | bash -s -- --domain code.example.com
#
# Installs Docker if missing, generates a password, writes .env, and brings the
# stack up. Run with no options for an interactive walk-through. Safe to re-run:
# existing settings are preserved unless overridden.
set -euo pipefail

REPO_URL="${AGENTBOX_REPO:-https://github.com/jabezpauls/agentbox.git}"
INSTALL_DIR="${AGENTBOX_DIR:-$HOME/agentbox}"
DOMAIN=""
MODE="standalone"
BIND="127.0.0.1:8443"
USERNAME="admin"
PASSWORD=""
CPUS="2"
MEMORY="4g"
PREVIEW_DOMAIN=""
PREVIEW_MODE="path"
EDGE_NETWORK="edge-prod"
CERT_RESOLVER="letsencrypt"
PROXY_CPUS="1"
PROXY_MEMORY="256m"
AGENTS="claude,codex"
ISOLATE_HOST="false"
ASSUME_YES="false"
INTERACTIVE="false"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<'USAGE'
Usage: install.sh [options]

Run with no options for an interactive walk-through.

  --domain <host>       Hostname you will browse to (required off localhost)
  --mode <mode>         standalone   (owns :80/:443, gets a TLS cert)
                        behind-proxy (loopback only, your proxy fronts it)
                        traefik      (no published port; a container Traefik routes to it)
  --bind <addr:port>    behind-proxy listen address (default 127.0.0.1:8443)
  --edge-network <name> traefik: external network Traefik watches (default edge-prod)
  --cert-resolver <n>   traefik: Traefik cert resolver (default letsencrypt)
  --user <name>         Login username (default admin)
  --password <pass>     Login password (default: generated and printed once)
  --preview-domain <h>  Serve each port at PORT.<h> (needs a wildcard DNS record)
  --preview <off|path>  Public preview sharing under /s/<token> (default path)
  --agents <list>       Coding agents to build in, comma-separated (default claude,codex)
  --isolate-host        Firewall the sandbox off the host and private networks
  --cpus <n>            Sandbox CPU ceiling per service (default 2)
  --memory <size>       Sandbox memory ceiling per service (default 4g)
  --proxy-cpus <n>      Proxy CPU ceiling (default 1)
  --proxy-memory <size> Proxy memory ceiling (default 256m)
  --dir <path>          Install directory (default ~/agentbox)
  --yes                 Do not prompt
  -h, --help            Show this help
USAGE
}

# Any argument at all means non-interactive; no arguments triggers the prompts.
[ $# -eq 0 ] && INTERACTIVE="true"

while [ $# -gt 0 ]; do
    case "$1" in
        --domain)        DOMAIN="${2:-}"; shift 2 ;;
        --mode)          MODE="${2:-}"; shift 2 ;;
        --bind)          BIND="${2:-}"; shift 2 ;;
        --edge-network)  EDGE_NETWORK="${2:-}"; shift 2 ;;
        --cert-resolver) CERT_RESOLVER="${2:-}"; shift 2 ;;
        --user)          USERNAME="${2:-}"; shift 2 ;;
        --password)      PASSWORD="${2:-}"; shift 2 ;;
        --preview-domain) PREVIEW_DOMAIN="${2:-}"; shift 2 ;;
        --preview)       PREVIEW_MODE="${2:-}"; shift 2 ;;
        --agents)        AGENTS="${2:-}"; shift 2 ;;
        --isolate-host)  ISOLATE_HOST="true"; shift ;;
        --cpus)          CPUS="${2:-}"; shift 2 ;;
        --memory)        MEMORY="${2:-}"; shift 2 ;;
        --proxy-cpus)    PROXY_CPUS="${2:-}"; shift 2 ;;
        --proxy-memory)  PROXY_MEMORY="${2:-}"; shift 2 ;;
        --dir)           INSTALL_DIR="${2:-}"; shift 2 ;;
        --yes|-y)        ASSUME_YES="true"; shift ;;
        -h|--help)       usage; exit 0 ;;
        *)               die "unknown option: $1 (try --help)" ;;
    esac
done

# --- Interactive walk-through -----------------------------------------------
# Ask the same questions the flags answer, each with its safe default already
# filled in, then print the resolved command before acting on it.
ask() {
    # ask <prompt> <default> <varname>
    local prompt="$1" default="$2" var="$3" reply=""
    printf '%s [%s]: ' "$prompt" "$default" >/dev/tty
    read -r reply </dev/tty || reply=""
    printf -v "$var" '%s' "${reply:-$default}"
}
ask_yn() {
    # ask_yn <prompt> <default y|n> <varname holding true/false>
    local prompt="$1" default="$2" var="$3" reply=""
    printf '%s [%s]: ' "$prompt" "$([ "$default" = y ] && echo Y/n || echo y/N)" >/dev/tty
    read -r reply </dev/tty || reply=""
    reply="${reply:-$default}"
    case "$reply" in [yY]*) printf -v "$var" 'true' ;; *) printf -v "$var" 'false' ;; esac
}

if [ "$INTERACTIVE" = "true" ]; then
    log "No options given; walking through the setup. Press Enter to accept a default."
    ask "Mode (standalone / behind-proxy / traefik)" "$MODE" MODE
    if [ "$MODE" = "standalone" ] || [ "$MODE" = "traefik" ]; then
        ask "Hostname you will browse to" "${DOMAIN:-code.example.com}" DOMAIN
    fi
    [ "$MODE" = "behind-proxy" ] && ask "Loopback listen address" "$BIND" BIND
    if [ "$MODE" = "traefik" ]; then
        ask "External Traefik network" "$EDGE_NETWORK" EDGE_NETWORK
        ask "Traefik cert resolver" "$CERT_RESOLVER" CERT_RESOLVER
    fi
    ask "Login username" "$USERNAME" USERNAME
    ask "Coding agents to build in (comma-separated: claude,codex)" "$AGENTS" AGENTS
    ask "Public preview sharing (off / path)" "$PREVIEW_MODE" PREVIEW_MODE
    ask "Per-port preview domain (blank for none)" "$PREVIEW_DOMAIN" PREVIEW_DOMAIN
    ask_yn "Firewall the sandbox off the host (shared host only)?" n ISOLATE_HOST

    # Echo the equivalent one-liner so the choices are reproducible and auditable.
    RESOLVED="install.sh --mode $MODE"
    [ -n "$DOMAIN" ] && RESOLVED="$RESOLVED --domain $DOMAIN"
    [ "$MODE" = "behind-proxy" ] && RESOLVED="$RESOLVED --bind $BIND"
    [ "$MODE" = "traefik" ] && RESOLVED="$RESOLVED --edge-network $EDGE_NETWORK --cert-resolver $CERT_RESOLVER"
    RESOLVED="$RESOLVED --user $USERNAME --agents $AGENTS --preview $PREVIEW_MODE"
    [ -n "$PREVIEW_DOMAIN" ] && RESOLVED="$RESOLVED --preview-domain $PREVIEW_DOMAIN"
    [ "$ISOLATE_HOST" = "true" ] && RESOLVED="$RESOLVED --isolate-host"
    printf '\n'
    log "Resolved command:"
    printf '  %s\n\n' "$RESOLVED"
    printf 'Proceed? [Y/n]: ' >/dev/tty
    read -r reply </dev/tty || reply="y"
    case "${reply:-y}" in [nN]*) die "aborted" ;; esac
fi

# --- Validation -------------------------------------------------------------
case "$MODE" in
    standalone|behind-proxy|traefik) ;;
    *) die "--mode must be standalone, behind-proxy or traefik" ;;
esac
case "$PREVIEW_MODE" in
    off|path) ;;
    *) die "--preview must be off or path" ;;
esac
if [ "$MODE" = "standalone" ] || [ "$MODE" = "traefik" ]; then
    [ -z "$DOMAIN" ] && die "--domain is required for $MODE mode"
fi
[ -z "$DOMAIN" ] && DOMAIN="localhost"

# --- Docker -----------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    log "Docker not found; installing via get.docker.com"
    [ "$ASSUME_YES" = "true" ] || {
        read -rp "Install Docker now? [y/N] " reply </dev/tty
        case "$reply" in [yY]*) ;; *) die "Docker is required" ;; esac
    }
    curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose)"
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon; add yourself to the docker group, or use rootless Docker, then re-run"

# --- Source -----------------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
    log "Updating existing install at $INSTALL_DIR"
    # A local checkout may have no upstream, or a pinned one. Failing to update
    # must not abort an otherwise valid install.
    git -C "$INSTALL_DIR" pull --ff-only \
        || warn "could not update the checkout; continuing with what is on disk"
elif [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    log "Using existing directory $INSTALL_DIR"
else
    log "Cloning into $INSTALL_DIR"
    command -v git >/dev/null 2>&1 || die "git is required"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# --- Credentials ------------------------------------------------------------
GENERATED="false"
KEPT="false"
if [ -z "$PASSWORD" ] && [ -f .env ] && grep -q '^AGENTBOX_PASSWORD_HASH=.\+' .env; then
    KEPT="true"
    log "Keeping the existing password"
    HASH_ESCAPED="$(grep '^AGENTBOX_PASSWORD_HASH=' .env | cut -d= -f2-)"
    HASH="$HASH_ESCAPED"
else
    if [ -z "$PASSWORD" ]; then
        PASSWORD="$(tr -dc 'a-z0-9' </dev/urandom | head -c 20)"
        GENERATED="true"
    fi
    log "Hashing the password"
    HASH="$(docker run --rm caddy:2-alpine caddy hash-password --plaintext "$PASSWORD")"
fi
[ -n "$HASH" ] || die "failed to generate a password hash"

# A bcrypt hash is full of '$', which Docker Compose reads as variable
# interpolation and would silently blank out, breaking the login. Escaping each
# '$' as '$$' makes Compose hand the container the literal hash.
HASH_ESCAPED="$(printf '%s' "$HASH" | sed 's/[$]/$$/g')"

# --- Configuration ----------------------------------------------------------
log "Writing .env"
umask 077
cat > .env <<ENVFILE
AGENTBOX_DOMAIN=$DOMAIN
AGENTBOX_MODE=$MODE
AGENTBOX_BIND=$BIND
AGENTBOX_EDGE_NETWORK=$EDGE_NETWORK
AGENTBOX_CERT_RESOLVER=$CERT_RESOLVER
AGENTBOX_USER=$USERNAME
AGENTBOX_PASSWORD_HASH=$HASH_ESCAPED
AGENTBOX_PREVIEW_DOMAIN=$PREVIEW_DOMAIN
AGENTBOX_PREVIEW_MODE=$PREVIEW_MODE
AGENTBOX_AGENTS=$AGENTS
AGENTBOX_PUBLIC_URL=https://$DOMAIN
AGENTBOX_CPUS=$CPUS
AGENTBOX_MEMORY=$MEMORY
AGENTBOX_PROXY_CPUS=$PROXY_CPUS
AGENTBOX_PROXY_MEMORY=$PROXY_MEMORY
TZ=$(cat /etc/timezone 2>/dev/null || echo UTC)
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
ENVFILE
chmod 600 .env

# --- Launch -----------------------------------------------------------------
# The preview overlay is an add-on, independent of the mode: it is composed in
# only when a preview domain was configured.
COMPOSE=(-f docker-compose.yml -f "docker-compose.$MODE.yml")
[ -n "$PREVIEW_DOMAIN" ] && COMPOSE+=(-f docker-compose.previews.yml)

log "Building the sandbox image (first run takes a few minutes)"
docker compose "${COMPOSE[@]}" build
log "Starting"
docker compose "${COMPOSE[@]}" up -d

# --- Host isolation ---------------------------------------------------------
# The manual firewall work, packaged. Shared with `agentbox update` so both
# render identical rules; see scripts/isolate-host.sh.
if [ "$ISOLATE_HOST" = "true" ]; then
    # shellcheck source=scripts/isolate-host.sh
    . "$INSTALL_DIR/scripts/isolate-host.sh"
    agentbox_isolate_host "${COMPOSE[@]}"
fi

# --- DNS (operator-only, but verified) --------------------------------------
# The one thing the installer cannot do for a third-party provider is add the
# record. Print exactly what to add, then poll until the name resolves.
wait_for_dns() {
    local host="$1" ip="" tries=0
    ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    printf '\n'
    log "DNS record to add at your provider:"
    printf '  Name    %s\n' "$host"
    printf '  Type    A\n'
    printf '  Value   %s\n' "${ip:-<the public IP of this server>}"
    printf '  Proxied your choice (Cloudflare: on is fine)\n\n'
    command -v getent >/dev/null 2>&1 || return 0
    printf 'Waiting for %s to resolve (Ctrl-C to skip)…\n' "$host"
    while [ "$tries" -lt 60 ]; do
        if getent hosts "$host" >/dev/null 2>&1; then
            printf '\033[1;32m  resolves now.\033[0m\n'
            return 0
        fi
        tries=$((tries + 1))
        sleep 5
    done
    warn "still not resolving after five minutes; the record may take longer to propagate"
}
if { [ "$MODE" = "standalone" ] || [ "$MODE" = "traefik" ]; } && [ "$DOMAIN" != "localhost" ]; then
    [ "$ASSUME_YES" = "true" ] || wait_for_dns "$DOMAIN"
fi

# --- Summary ----------------------------------------------------------------
printf '\n\033[1;32magentbox is up.\033[0m\n\n'
case "$MODE" in
    standalone)
        printf '  URL       https://%s\n' "$DOMAIN"
        printf '            (point this DNS name at this server; the certificate is issued on first visit)\n' ;;
    traefik)
        printf '  URL       https://%s\n' "$DOMAIN"
        printf '            (routed by your Traefik on the %s network; no port is published)\n' "$EDGE_NETWORK" ;;
    behind-proxy)
        printf '  Listening %s\n' "$BIND"
        printf '            Point your existing reverse proxy at that address.\n' ;;
esac
printf '  Username  %s\n' "$USERNAME"
if [ "$GENERATED" = "true" ]; then
    printf '  Password  %s\n\n' "$PASSWORD"
    printf '  This password is shown once. Save it now.\n'
elif [ "$KEPT" = "true" ]; then
    printf '  Password  (unchanged)\n'
else
    printf '  Password  (the one you passed with --password)\n'
fi
printf '  Agents    %s\n' "$AGENTS"
printf '  Sharing   %s\n' "$PREVIEW_MODE"
printf '\n  Editor /   Workbench /workbench   Terminal /terminal   Shell /shell   Monitor /monitor\n'
if [ -n "$PREVIEW_DOMAIN" ]; then
    printf '  Previews   https://PORT.%s  (needs a wildcard DNS record)\n' "$PREVIEW_DOMAIN"
fi
if [ "$PREVIEW_MODE" = "path" ]; then
    printf '  Share a port from the preview panel to get a public https://%s/s/<token>/ link.\n' "$DOMAIN"
fi
printf '\n'
