#!/usr/bin/env bash
# agentbox installer.
#
#   curl -fsSL https://raw.githubusercontent.com/jabezpauls/agentbox/main/install.sh \
#     | bash -s -- --domain code.example.com
#
# Installs Docker if missing, generates a password, writes .env, and brings the
# stack up. Safe to re-run: existing settings are preserved unless overridden.
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
ASSUME_YES="false"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<'USAGE'
Usage: install.sh [options]

  --domain <host>      Hostname you will browse to (required for standalone)
  --mode <mode>        standalone (owns :80/:443, gets a TLS cert)
                       behind-proxy (loopback only, your proxy fronts it)
  --bind <addr:port>   behind-proxy listen address (default 127.0.0.1:8443)
  --user <name>        Login username (default admin)
  --password <pass>    Login password (default: generated and printed once)
  --cpus <n>           CPU ceiling per service (default 2)
  --memory <size>      Memory ceiling per service (default 4g)
  --dir <path>         Install directory (default ~/agentbox)
  --yes                Do not prompt
  -h, --help           Show this help
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --domain)   DOMAIN="${2:-}"; shift 2 ;;
        --mode)     MODE="${2:-}"; shift 2 ;;
        --bind)     BIND="${2:-}"; shift 2 ;;
        --user)     USERNAME="${2:-}"; shift 2 ;;
        --password) PASSWORD="${2:-}"; shift 2 ;;
        --cpus)     CPUS="${2:-}"; shift 2 ;;
        --memory)   MEMORY="${2:-}"; shift 2 ;;
        --dir)      INSTALL_DIR="${2:-}"; shift 2 ;;
        --yes|-y)   ASSUME_YES="true"; shift ;;
        -h|--help)  usage; exit 0 ;;
        *)          die "unknown option: $1 (try --help)" ;;
    esac
done

case "$MODE" in
    standalone|behind-proxy) ;;
    *) die "--mode must be standalone or behind-proxy" ;;
esac
[ "$MODE" = "standalone" ] && [ -z "$DOMAIN" ] && die "--domain is required for standalone mode"
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
if [ -z "$PASSWORD" ] && [ -f .env ] && grep -q '^AGENTBOX_PASSWORD_HASH=.\+' .env; then
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
AGENTBOX_USER=$USERNAME
AGENTBOX_PASSWORD_HASH=$HASH_ESCAPED
AGENTBOX_CPUS=$CPUS
AGENTBOX_MEMORY=$MEMORY
TZ=$(cat /etc/timezone 2>/dev/null || echo UTC)
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
ENVFILE
chmod 600 .env

# --- Launch -----------------------------------------------------------------
log "Building the sandbox image (first run takes a few minutes)"
docker compose -f docker-compose.yml -f "docker-compose.$MODE.yml" build
log "Starting"
docker compose -f docker-compose.yml -f "docker-compose.$MODE.yml" up -d

printf '\n\033[1;32magentbox is up.\033[0m\n\n'
if [ "$MODE" = "standalone" ]; then
    printf '  URL       https://%s\n' "$DOMAIN"
    printf '            (point this DNS name at this server; the certificate is issued on first visit)\n'
else
    printf '  Listening %s\n' "$BIND"
    printf '            Point your existing reverse proxy at that address.\n'
fi
printf '  Username  %s\n' "$USERNAME"
if [ "$GENERATED" = "true" ]; then
    printf '  Password  %s\n\n' "$PASSWORD"
    printf '  This password is shown once. Save it now.\n'
else
    printf '  Password  (unchanged)\n'
fi
printf '\n  Editor /   Terminal /terminal   Monitor /monitor\n\n'
