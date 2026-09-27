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
PREVIEW_MODE="path"
# Behind Cloudflare? on/off; empty until decided (flag, .env, or the mode's default).
CLOUDFLARE=""
EDGE_NETWORK="edge-prod"
CERT_RESOLVER="letsencrypt"
PROXY_CPUS="1"
PROXY_MEMORY="256m"
AGENTS="claude,codex"
ISOLATE_HOST="false"
PUBLIC_URL=""
ASSUME_YES="false"
INTERACTIVE="false"
# Names of the settings given on the command line. Those override .env; every
# other setting keeps what an existing install already has.
EXPLICIT=" "

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
  --password <pass>     Login password (default: generated and printed once);
                        on an existing install, replaces the current one
  --preview <off|path>  Kept for compatibility; public /s/ shares are off
  --cloudflare <on|off> The hostname is proxied through Cloudflare (default on in
                        traefik mode, off otherwise); decides whose address the
                        sign-in limits count
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

# flag <VAR> <value>: set a setting from the command line and remember that it
# was given, so an existing .env does not override it.
flag() {
    case "$2" in
        *$'\n'*|*$'\r'*) die "option values may not contain a newline" ;;
    esac
    printf -v "$1" '%s' "$2"
    EXPLICIT="$EXPLICIT$1 "
}

while [ $# -gt 0 ]; do
    case "$1" in
        --domain)        flag DOMAIN "${2:-}"; shift 2 ;;
        --mode)          flag MODE "${2:-}"; shift 2 ;;
        --bind)          flag BIND "${2:-}"; shift 2 ;;
        --edge-network)  flag EDGE_NETWORK "${2:-}"; shift 2 ;;
        --cert-resolver) flag CERT_RESOLVER "${2:-}"; shift 2 ;;
        --user)          flag USERNAME "${2:-}"; shift 2 ;;
        --password)      flag PASSWORD "${2:-}"; shift 2 ;;
        --preview-domain)
            # Per-port preview hostnames were removed: the gate's sign-in
            # cookie is host-only, so it never reaches another hostname.
            warn "--preview-domain no longer does anything; ignoring it"
            shift 2 ;;
        --preview)       flag PREVIEW_MODE "${2:-}"; shift 2 ;;
        --cloudflare)    flag CLOUDFLARE "${2:-}"; shift 2 ;;
        --agents)        flag AGENTS "${2:-}"; shift 2 ;;
        --isolate-host)  ISOLATE_HOST="true"; shift ;;
        --cpus)          flag CPUS "${2:-}"; shift 2 ;;
        --memory)        flag MEMORY "${2:-}"; shift 2 ;;
        --proxy-cpus)    flag PROXY_CPUS "${2:-}"; shift 2 ;;
        --proxy-memory)  flag PROXY_MEMORY "${2:-}"; shift 2 ;;
        --dir)           INSTALL_DIR="${2:-}"; shift 2 ;;
        --yes|-y)        ASSUME_YES="true"; shift ;;
        -h|--help)       usage; exit 0 ;;
        *)               die "unknown option: $1 (try --help)" ;;
    esac
done

# --- Existing settings ------------------------------------------------------
# Re-running the installer — to add --isolate-host, say — must not quietly
# reset an install to the defaults: a traefik box flipping to standalone would
# try to take :80/:443. So an existing .env supplies every setting that was not
# given on the command line, and the rewrite below keeps every key it does not
# manage (API keys, TZ, anything added by hand).
ENV_FILE="$INSTALL_DIR/.env"
# The keys this installer manages, and the setting each one holds.
MANAGED="AGENTBOX_DOMAIN:DOMAIN AGENTBOX_MODE:MODE AGENTBOX_BIND:BIND
AGENTBOX_EDGE_NETWORK:EDGE_NETWORK AGENTBOX_CERT_RESOLVER:CERT_RESOLVER
AGENTBOX_USER:USERNAME AGENTBOX_PREVIEW_MODE:PREVIEW_MODE AGENTBOX_CLOUDFLARE:CLOUDFLARE AGENTBOX_AGENTS:AGENTS
AGENTBOX_PUBLIC_URL:PUBLIC_URL AGENTBOX_CPUS:CPUS AGENTBOX_MEMORY:MEMORY
AGENTBOX_PROXY_CPUS:PROXY_CPUS AGENTBOX_PROXY_MEMORY:PROXY_MEMORY"
if [ -f "$ENV_FILE" ]; then
    for pair in $MANAGED; do
        key="${pair%%:*}"; var="${pair#*:}"
        case "$EXPLICIT" in *" $var "*) continue ;; esac
        # A present-but-empty key is a choice (no agents, no public URL).
        grep -q "^$key=" "$ENV_FILE" || continue
        printf -v "$var" '%s' "$(grep -m1 "^$key=" "$ENV_FILE" | cut -d= -f2-)"
    done
fi
# The public URL follows the domain whenever the domain was just given, or no
# URL is recorded yet. It is left blank for localhost: https://localhost is
# never a link anyone else can open — so one an older installer recorded is
# dropped too, rather than kept forever as a "setting".
case "$EXPLICIT" in *" DOMAIN "*) PUBLIC_URL="" ;; esac
case "$PUBLIC_URL" in
    http://localhost|http://localhost[:/]*|https://localhost|https://localhost[:/]*|\
    http://127.0.0.1|http://127.0.0.1[:/]*|https://127.0.0.1|https://127.0.0.1[:/]*)
        PUBLIC_URL="" ;;
esac
# Behind Cloudflare, when neither this run nor .env says: an older .env said it
# with AGENTBOX_CLIENT_IP_HEADER (CF-Connecting-IP meant yes; anything else,
# empty included, no); failing that, the mode's default — traefik installs have
# always assumed Cloudflare.
CF_FROM_MODE="false"
if [ -z "$CLOUDFLARE" ]; then
    if [ -f "$ENV_FILE" ] && grep -q '^AGENTBOX_CLIENT_IP_HEADER=' "$ENV_FILE"; then
        case "$(grep -m1 '^AGENTBOX_CLIENT_IP_HEADER=' "$ENV_FILE" | cut -d= -f2- | tr '[:upper:]' '[:lower:]')" in
            cf-connecting-ip) CLOUDFLARE="on" ;;
            *) CLOUDFLARE="off" ;;
        esac
    else
        CF_FROM_MODE="true"
        if [ "$MODE" = "traefik" ]; then CLOUDFLARE="on"; else CLOUDFLARE="off"; fi
    fi
fi

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
    # The mode may have just changed; so may its default.
    if [ "$CF_FROM_MODE" = "true" ]; then
        if [ "$MODE" = "traefik" ]; then CLOUDFLARE="on"; else CLOUDFLARE="off"; fi
    fi
    ask "Is the hostname proxied through Cloudflare? (on / off)" "$CLOUDFLARE" CLOUDFLARE
    ask_yn "Firewall the sandbox off the host (shared host only)?" n ISOLATE_HOST

    # Echo the equivalent one-liner so the choices are reproducible and auditable.
    RESOLVED="install.sh --mode $MODE"
    [ -n "$DOMAIN" ] && RESOLVED="$RESOLVED --domain $DOMAIN"
    [ "$MODE" = "behind-proxy" ] && RESOLVED="$RESOLVED --bind $BIND"
    [ "$MODE" = "traefik" ] && RESOLVED="$RESOLVED --edge-network $EDGE_NETWORK --cert-resolver $CERT_RESOLVER"
    RESOLVED="$RESOLVED --user $USERNAME --agents $AGENTS --cloudflare $CLOUDFLARE"
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
case "$CLOUDFLARE" in
    on|off) ;;
    *) die "--cloudflare must be on or off" ;;
esac
# A password chosen on the command line is checked here, before anything is
# written or started: the gate would refuse it only after the stack is up.
if [ -n "$PASSWORD" ]; then
    [ "${#PASSWORD}" -ge 8 ] || die "--password must be at least 8 characters"
    [ "$(printf '%s' "$PASSWORD" | wc -c)" -le 72 ] || die "--password must be at most 72 bytes (bcrypt ignores the rest)"
fi
case "$PREVIEW_MODE" in
    off|path) ;;
    *) die "--preview must be off or path" ;;
esac
if [ "$MODE" = "standalone" ] || [ "$MODE" = "traefik" ]; then
    [ -z "$DOMAIN" ] && die "--domain is required for $MODE mode"
fi
[ -z "$DOMAIN" ] && DOMAIN="localhost"
if [ -z "$PUBLIC_URL" ] && [ "$DOMAIN" != "localhost" ]; then
    PUBLIC_URL="https://$DOMAIN"
fi
case "$AGENTS" in
    *[!a-z0-9,_-]*) die "--agents takes a comma-separated list of agent names (e.g. claude,codex)" ;;
esac

# AGENTBOX_INSTALL_ENV_ONLY=1 writes .env and stops, without touching Docker or
# the checkout. It exists so tests/install/ can check what a re-run preserves.
ENV_ONLY="${AGENTBOX_INSTALL_ENV_ONLY:-}"

# --- Docker -----------------------------------------------------------------
if [ -n "$ENV_ONLY" ]; then
    [ -d "$INSTALL_DIR" ] || die "no install at $INSTALL_DIR"
elif ! command -v docker >/dev/null 2>&1; then
    log "Docker not found; installing via get.docker.com"
    [ "$ASSUME_YES" = "true" ] || {
        read -rp "Install Docker now? [y/N] " reply </dev/tty
        case "$reply" in [yY]*) ;; *) die "Docker is required" ;; esac
    }
    curl -fsSL https://get.docker.com | sh
fi
if [ -z "$ENV_ONLY" ]; then
    docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose)"
    docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon; add yourself to the docker group, or use rootless Docker, then re-run"
fi

# --- Source -----------------------------------------------------------------
if [ -n "$ENV_ONLY" ]; then
    :
elif [ -d "$INSTALL_DIR/.git" ]; then
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
    # Stored Compose-escaped ('$$'); undo that so it is escaped exactly once
    # below, rather than doubling on every re-run and breaking the login.
    HASH="$(grep -m1 '^AGENTBOX_PASSWORD_HASH=' .env | cut -d= -f2- | sed 's/[$][$]/$/g')"
else
    if [ -z "$PASSWORD" ]; then
        PASSWORD="$(tr -dc 'a-z0-9' </dev/urandom | head -c 20)"
        GENERATED="true"
    fi
    log "Hashing the password"
    # On stdin rather than in argv, where a process listing would show it.
    # The hash seeds the gate's store on a fresh install; the gate is told the
    # password itself once it is up (see Launch).
    HASH="$(printf '%s\n' "$PASSWORD" | docker run --rm -i caddy:2-alpine caddy hash-password)"
fi
[ -n "$HASH" ] || die "failed to generate a password hash"

# A bcrypt hash is full of '$', which Docker Compose reads as variable
# interpolation and would silently blank out, breaking the login. Escaping each
# '$' as '$$' makes Compose hand the container the literal hash.
HASH_ESCAPED="$(printf '%s' "$HASH" | sed 's/[$]/$$/g')"

# --- Configuration ----------------------------------------------------------
log "Writing .env"
umask 077
NEW_ENV="$(mktemp .env.XXXXXX)"
if [ -f .env ]; then
    # Keep every line this installer does not manage — API keys, TZ, comments,
    # settings added by hand — exactly as it was.
    managed_re="^(AGENTBOX_PASSWORD_HASH"
    for pair in $MANAGED; do managed_re="$managed_re|${pair%%:*}"; done
    managed_re="$managed_re)="
    grep -Ev "$managed_re" .env > "$NEW_ENV" || true
else
    {
        printf 'TZ=%s\n' "$(cat /etc/timezone 2>/dev/null || echo UTC)"
        printf 'ANTHROPIC_API_KEY=%s\n' "${ANTHROPIC_API_KEY:-}"
        printf 'OPENAI_API_KEY=%s\n' "${OPENAI_API_KEY:-}"
    } > "$NEW_ENV"
fi
cat >> "$NEW_ENV" <<ENVFILE
AGENTBOX_DOMAIN=$DOMAIN
AGENTBOX_MODE=$MODE
AGENTBOX_BIND=$BIND
AGENTBOX_EDGE_NETWORK=$EDGE_NETWORK
AGENTBOX_CERT_RESOLVER=$CERT_RESOLVER
AGENTBOX_USER=$USERNAME
AGENTBOX_PASSWORD_HASH=$HASH_ESCAPED
AGENTBOX_PREVIEW_MODE=$PREVIEW_MODE
AGENTBOX_CLOUDFLARE=$CLOUDFLARE
AGENTBOX_AGENTS=$AGENTS
AGENTBOX_PUBLIC_URL=$PUBLIC_URL
AGENTBOX_CPUS=$CPUS
AGENTBOX_MEMORY=$MEMORY
AGENTBOX_PROXY_CPUS=$PROXY_CPUS
AGENTBOX_PROXY_MEMORY=$PROXY_MEMORY
ENVFILE
chmod 600 "$NEW_ENV"
mv "$NEW_ENV" .env
[ -n "$ENV_ONLY" ] && { log "Wrote .env (env-only run; nothing else done)"; exit 0; }

# --- Launch -----------------------------------------------------------------
COMPOSE=(-f docker-compose.yml -f "docker-compose.$MODE.yml")

log "Building the sandbox and gate images (first run takes a few minutes)"
docker compose "${COMPOSE[@]}" build
log "Starting"
docker compose "${COMPOSE[@]}" up -d

# The gate's store, not .env, holds the password: .env's hash only seeds a
# store that does not exist yet. So a password chosen now — given with
# --password, or generated — is set in the store through the gate itself, which
# is what makes --password work on an existing install too. The command waits
# for a gate that is still starting.
if [ "$KEPT" != "true" ]; then
    log "Setting the password in the gate"
    printf '%s\n' "$PASSWORD" | docker compose "${COMPOSE[@]}" exec -T gate agentbox-gate set-password >/dev/null \
        || die "could not set the password in the gate; see: docker compose logs gate"
fi

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
printf '  Cloudflare %s  (whose address sign-in limits count: --cloudflare on|off)\n' "$CLOUDFLARE"
printf '\n  Sign in at /login, then: Editor /vscode/   Workbench /workbench   Terminal /terminal   Shell /shell   Monitor /monitor\n'
printf '  Change the password with ./scripts/agentbox passwd; two-factor is optional (see docs/install.md).\n'
printf '\n'
