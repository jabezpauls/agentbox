#!/usr/bin/env bash
# agentbox installer.
#
#   curl -fsSL https://github.com/jabezpauls/agentbox/releases/latest/download/install.sh -o install.sh
#   sudo bash install.sh --domain code.example.com
#
# Installs Docker if missing, downloads a release (its compose files, proxy
# configuration and scripts; the images are pulled from ghcr.io), generates a
# password, writes .env, and brings the stack up. Run with no options for an
# interactive walk-through. Safe to re-run: existing settings are preserved
# unless overridden. Run from inside a clone of the repository, it uses that
# clone and builds the images from it.
set -euo pipefail

REPO_URL="${AGENTBOX_REPO:-https://github.com/jabezpauls/agentbox.git}"
# Where releases are downloaded from: <url>/latest/download/<file> and
# <url>/download/<tag>/<file>, GitHub's layout. Overridable for a mirror, or
# for testing a release before it is published.
RELEASE_URL="${AGENTBOX_RELEASE_URL:-}"
INSTALL_DIR="${AGENTBOX_DIR:-}"
# The release to install (--version): empty means the one already installed,
# or for a new install the one this script came with.
RELEASE=""
# The release this copy of the script was published with; scripts/
# build-release.sh fills it in. Empty in the repository: the latest.
DEFAULT_RELEASE=""
# on: build the images here; off: pull the prebuilt ones; empty: decide (see
# scripts/agentbox, `apply`).
BUILD=""
FROM_GIT="false"
DOMAIN=""
MODE="standalone"
BIND="127.0.0.1:8443"
BIND_PUBLIC="off"
USERNAME="admin"
PASSWORD=""
CPUS="2"
MEMORY="4g"
SHARING="on"
# Behind Cloudflare? on/off; empty until decided (flag, .env, or the mode's default).
CLOUDFLARE=""
# A header the operator's own proxy sets to the client's address (behind-proxy
# and traefik modes); empty for none.
REAL_IP_HEADER=""
EDGE_NETWORK="edge-prod"
CERT_RESOLVER="letsencrypt"
# traefik: who terminates TLS. edge = Traefik (an HTTP router, its certificate);
# passthrough = Caddy, with its own certificate, Traefik passing TLS through.
TLS="edge"
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
# Twenty random lowercase letters and digits. `tr` is cut off by `head` once
# it has enough (SIGPIPE), which pipefail would count as a failure: read a
# fixed amount first, and check the length instead.
random_password() {
    local p
    p="$(head -c 4096 /dev/urandom | LC_ALL=C tr -dc 'a-z0-9' | cut -c1-20)"
    [ "${#p}" -eq 20 ] || die "could not generate a password"
    printf '%s' "$p"
}

usage() {
    cat <<'USAGE'
Usage: install.sh [options]

Run with no options for an interactive walk-through.

  --domain <host>       Hostname you will browse to (required off localhost)
  --mode <mode>         standalone   (owns :80/:443, gets a TLS cert)
                        behind-proxy (loopback only, your proxy fronts it)
                        traefik      (no published port; a container Traefik routes to it)
  --bind <addr:port>    behind-proxy listen address (default 127.0.0.1:8443);
                        loopback only unless --bind-public
  --bind-public         Allow --bind on an address other people can reach
                        (see docs/install.md before using it)
  --edge-network <name> traefik: external network Traefik watches (default edge-prod)
  --cert-resolver <n>   traefik: Traefik cert resolver (default letsencrypt)
  --tls <edge|passthrough>
                        traefik: who terminates TLS. edge (default): Traefik,
                        with its resolver's certificate. passthrough: Caddy,
                        with its own Let's Encrypt certificate, for a DNS-only
                        record (implies --cloudflare off; see docs/install.md)
  --user <name>         Login username (default admin)
  --password <pass>     Login password (default: generated and printed once);
                        on an existing install, replaces the current one
  --sharing <on|off>    Whether you may make an app public from the Preview
                        panel (default on); off keeps every app private
  --preview <path|off>  The older name of --sharing (path means on)
  --cloudflare <on|off> The hostname is proxied through Cloudflare (default on in
                        traefik mode, off otherwise); decides whose address the
                        sign-in limits count
  --real-ip-header <h>  behind-proxy/traefik: a header your own proxy sets to the
                        client's address and overwrites on every request (e.g.
                        X-Real-IP); read before X-Forwarded-For. Not for
                        Cloudflare (use --cloudflare on); default none
  --agents <list>       Coding agents in the sandbox, comma-separated (default
                        claude,codex, the prebuilt image; any other list builds
                        the image here)
  --version <tag>       Release to install, e.g. v1.2.0 (default: the latest,
                        or on an existing install the one it has)
  --build               Build the images on this server instead of pulling them
  --no-build            Pull the prebuilt images again (after --build)
  --from-git            Clone the repository into --dir and build from it, as
                        installs before releases did
  --isolate-host        Firewall the sandbox off the host and private networks
  --cpus <n>            Sandbox CPU ceiling per service (default 2)
  --memory <size>       Sandbox memory ceiling per service (default 4g)
  --proxy-cpus <n>      Proxy CPU ceiling (default 1)
  --proxy-memory <size> Proxy memory ceiling (default 256m)
  --dir <path>          Install directory (default /opt/agentbox as root or under
                        sudo, ~/agentbox otherwise, or the clone this script
                        sits in; an existing install is kept where it is)
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
        --bind-public)   flag BIND_PUBLIC on; shift ;;
        --edge-network)  flag EDGE_NETWORK "${2:-}"; shift 2 ;;
        --cert-resolver) flag CERT_RESOLVER "${2:-}"; shift 2 ;;
        --tls)           flag TLS "${2:-}"; shift 2 ;;
        --user)          flag USERNAME "${2:-}"; shift 2 ;;
        --password)      flag PASSWORD "${2:-}"; shift 2 ;;
        --preview-domain)
            # Per-port preview hostnames were removed: the gate's sign-in
            # cookie is host-only, so it never reaches another hostname.
            warn "--preview-domain no longer does anything; ignoring it"
            shift 2 ;;
        --sharing)       flag SHARING "${2:-}"; shift 2 ;;
        --preview)
            # The older name: `path` allowed sharing, `off` did not.
            case "${2:-}" in
                path) flag SHARING on ;;
                off)  flag SHARING off ;;
                *)    die "--preview must be off or path (or use --sharing on|off)" ;;
            esac
            shift 2 ;;
        --cloudflare)    flag CLOUDFLARE "${2:-}"; shift 2 ;;
        --real-ip-header) flag REAL_IP_HEADER "${2:-}"; shift 2 ;;
        --agents)        flag AGENTS "${2:-}"; shift 2 ;;
        --isolate-host)  ISOLATE_HOST="true"; shift ;;
        --cpus)          flag CPUS "${2:-}"; shift 2 ;;
        --memory)        flag MEMORY "${2:-}"; shift 2 ;;
        --proxy-cpus)    flag PROXY_CPUS "${2:-}"; shift 2 ;;
        --proxy-memory)  flag PROXY_MEMORY "${2:-}"; shift 2 ;;
        --version)       RELEASE="${2:-}"; shift 2 ;;
        --build)         flag BUILD on; shift ;;
        --no-build)      flag BUILD off; shift ;;
        --from-git)      FROM_GIT="true"; shift ;;
        --dir)           INSTALL_DIR="${2:-}"; [ -n "$INSTALL_DIR" ] || die "--dir needs a path"; shift 2 ;;
        --yes|-y)        ASSUME_YES="true"; shift ;;
        -h|--help)       usage; exit 0 ;;
        *)               die "unknown option: $1 (try --help)" ;;
    esac
done

# --- Where ------------------------------------------------------------------
# Run as a file from inside a clone (or an unpacked release), this script
# installs that directory, unless --dir says otherwise. Piped into bash, or
# downloaded on its own, it installs to /opt/agentbox as root (sudo included),
# and to ~/agentbox as a user with Docker access. An existing install stays
# where it is: a re-run as root finds one in root's or the sudo user's home.
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
default_install_dir() {
    local sudo_home=""
    if [ "$(id -u)" != 0 ]; then
        printf '%s' "$HOME/agentbox"
        return
    fi
    [ -f /opt/agentbox/docker-compose.yml ] && { printf '/opt/agentbox'; return; }
    [ -f "$HOME/agentbox/docker-compose.yml" ] && { printf '%s' "$HOME/agentbox"; return; }
    if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
        sudo_home="$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6 || true)"
        [ -n "$sudo_home" ] && [ -f "$sudo_home/agentbox/docker-compose.yml" ] && { printf '%s' "$sudo_home/agentbox"; return; }
    fi
    printf '/opt/agentbox'
}
if [ -z "$INSTALL_DIR" ]; then
    if [ "$FROM_GIT" != "true" ] && [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/docker-compose.yml" ] && [ -f "$SELF_DIR/scripts/agentbox" ]; then
        INSTALL_DIR="$SELF_DIR"
    else
        INSTALL_DIR="$(default_install_dir)"
    fi
fi
# A release is a tag: v1.2.3, with an optional -suffix. `1.2.3` means v1.2.3.
case "$RELEASE" in
    [0-9]*) RELEASE="v$RELEASE" ;;
esac
if [ -n "$RELEASE" ] && [ "$RELEASE" != latest ] && ! printf '%s' "$RELEASE" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; then
    die "--version takes a release tag such as v1.2.0, or latest"
fi
# What to download for a new install: the release asked for, else the one
# this script was published with, else the latest ("" below).
case "$RELEASE" in
    latest) WANT="" ;;
    "") WANT="$DEFAULT_RELEASE" ;;
    *) WANT="$RELEASE" ;;
esac
[ "$FROM_GIT" = "true" ] && [ -n "$RELEASE" ] && die "--from-git builds the repository's default branch; it does not take --version"

# --- Existing settings ------------------------------------------------------
# Re-running the installer — to add --isolate-host, say — must not quietly
# reset an install to the defaults: a traefik box flipping to standalone would
# try to take :80/:443. So an existing .env supplies every setting that was not
# given on the command line, and the rewrite below keeps every key it does not
# manage (API keys, TZ, anything added by hand).
ENV_FILE="$INSTALL_DIR/.env"
# The keys this installer manages, and the setting each one holds.
MANAGED="AGENTBOX_DOMAIN:DOMAIN AGENTBOX_MODE:MODE AGENTBOX_BIND:BIND AGENTBOX_BIND_PUBLIC:BIND_PUBLIC
AGENTBOX_EDGE_NETWORK:EDGE_NETWORK AGENTBOX_CERT_RESOLVER:CERT_RESOLVER AGENTBOX_TLS:TLS
AGENTBOX_USER:USERNAME AGENTBOX_SHARING:SHARING AGENTBOX_CLOUDFLARE:CLOUDFLARE AGENTBOX_AGENTS:AGENTS
AGENTBOX_REAL_IP_HEADER:REAL_IP_HEADER
AGENTBOX_PUBLIC_URL:PUBLIC_URL AGENTBOX_CPUS:CPUS AGENTBOX_MEMORY:MEMORY
AGENTBOX_PROXY_CPUS:PROXY_CPUS AGENTBOX_PROXY_MEMORY:PROXY_MEMORY AGENTBOX_BUILD:BUILD"
if [ -f "$ENV_FILE" ]; then
    for pair in $MANAGED; do
        key="${pair%%:*}"; var="${pair#*:}"
        case "$EXPLICIT" in *" $var "*) continue ;; esac
        # A present-but-empty key is a choice (no agents, no public URL).
        grep -q "^$key=" "$ENV_FILE" || continue
        printf -v "$var" '%s' "$(grep -m1 "^$key=" "$ENV_FILE" | cut -d= -f2-)"
    done
fi
# Sharing, when neither this run nor .env says: an older .env said it with
# AGENTBOX_PREVIEW_MODE (path meant sharing was allowed, off that it was not).
if [ -f "$ENV_FILE" ] && ! grep -q '^AGENTBOX_SHARING=' "$ENV_FILE" && grep -q '^AGENTBOX_PREVIEW_MODE=' "$ENV_FILE"; then
    case "$EXPLICIT" in
        *" SHARING "*) ;;
        *) if [ "$(grep -m1 '^AGENTBOX_PREVIEW_MODE=' "$ENV_FILE" | cut -d= -f2-)" = off ]; then SHARING="off"; fi ;;
    esac
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
# The release server an existing install was set up with, unless the
# environment names another.
if [ -z "$RELEASE_URL" ] && [ -f "$ENV_FILE" ] && grep -q '^AGENTBOX_RELEASE_URL=.' "$ENV_FILE"; then
    RELEASE_URL="$(grep -m1 '^AGENTBOX_RELEASE_URL=' "$ENV_FILE" | cut -d= -f2-)"
fi
CF_FROM_MODE="false"
if [ -z "$CLOUDFLARE" ]; then
    if [ -f "$ENV_FILE" ] && grep -q '^AGENTBOX_CLIENT_IP_HEADER=' "$ENV_FILE"; then
        case "$(grep -m1 '^AGENTBOX_CLIENT_IP_HEADER=' "$ENV_FILE" | cut -d= -f2- | tr '[:upper:]' '[:lower:]')" in
            cf-connecting-ip) CLOUDFLARE="on" ;;
            *) CLOUDFLARE="off" ;;
        esac
    else
        CF_FROM_MODE="true"
        if [ "$MODE" = "traefik" ] && [ "$TLS" != passthrough ]; then CLOUDFLARE="on"; else CLOUDFLARE="off"; fi
    fi
fi
# That older key also named the header Traefik's rate limit keyed on. Caddy now
# reads AGENTBOX_REAL_IP_HEADER instead: a name Caddy already reads itself
# (CF-Connecting-IP, X-Forwarded-For) listed twice would stop it starting, so
# the old key is dropped from .env below and only another header moves over.
# (Caddy never reads the old key, so an .env still carrying it, say after an
# update run by an older script, starts fine.)
if [ -f "$ENV_FILE" ] && grep -q '^AGENTBOX_CLIENT_IP_HEADER=' "$ENV_FILE" \
    && ! grep -q '^AGENTBOX_REAL_IP_HEADER=' "$ENV_FILE"; then
    case "$EXPLICIT" in
        *" REAL_IP_HEADER "*) ;;
        *)
            OLD_IP_HEADER="$(grep -m1 '^AGENTBOX_CLIENT_IP_HEADER=' "$ENV_FILE" | cut -d= -f2-)"
            case "$(printf '%s' "$OLD_IP_HEADER" | tr '[:upper:]' '[:lower:]')" in
                ""|cf-connecting-ip|x-forwarded-for) ;;
                *) REAL_IP_HEADER="$OLD_IP_HEADER" ;;
            esac ;;
    esac
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
        ask "Who terminates TLS: Traefik, or this box behind a DNS-only record? (edge / passthrough)" "$TLS" TLS
        [ "$TLS" = passthrough ] || ask "Traefik cert resolver" "$CERT_RESOLVER" CERT_RESOLVER
    fi
    ask "Login username" "$USERNAME" USERNAME
    ask "Coding agents (claude,codex is prebuilt; any other list builds the image here)" "$AGENTS" AGENTS
    # The mode may have just changed; so may its default.
    if [ "$CF_FROM_MODE" = "true" ]; then
        if [ "$MODE" = "traefik" ] && [ "$TLS" != passthrough ]; then CLOUDFLARE="on"; else CLOUDFLARE="off"; fi
    fi
    if [ "$MODE" = "traefik" ] && [ "$TLS" = passthrough ]; then
        CLOUDFLARE="off"
    else
        ask "Is the hostname proxied through Cloudflare? (on / off)" "$CLOUDFLARE" CLOUDFLARE
    fi
    ask_yn "Firewall the sandbox off the host (shared host only)?" n ISOLATE_HOST

    # Echo the equivalent one-liner so the choices are reproducible and auditable.
    RESOLVED="install.sh --mode $MODE"
    [ -n "$DOMAIN" ] && RESOLVED="$RESOLVED --domain $DOMAIN"
    [ "$MODE" = "behind-proxy" ] && RESOLVED="$RESOLVED --bind $BIND"
    [ "$MODE" = "traefik" ] && RESOLVED="$RESOLVED --edge-network $EDGE_NETWORK --cert-resolver $CERT_RESOLVER --tls $TLS"
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
case "$TLS" in
    edge|passthrough) ;;
    *) die "--tls must be edge or passthrough" ;;
esac
# Passthrough means nothing in front of Caddy reads the request: no Cloudflare
# proxy (it could not reach Caddy's certificate) and no proxy header to read.
# What .env carried over from edge mode gives way; what was asked for now is
# refused.
if [ "$TLS" = passthrough ]; then
    [ "$MODE" = traefik ] || die "--tls passthrough is for traefik mode (standalone already terminates TLS itself)"
    if [ "$CLOUDFLARE" = on ]; then
        case "$EXPLICIT" in *" CLOUDFLARE "*) die "--tls passthrough serves a DNS-only record: it cannot be behind Cloudflare's proxy (--cloudflare off)" ;; esac
        warn "--tls passthrough: the record must be DNS-only, so AGENTBOX_CLOUDFLARE becomes off"
        CLOUDFLARE="off"
    fi
    if [ -n "$REAL_IP_HEADER" ]; then
        case "$EXPLICIT" in *" REAL_IP_HEADER "*) die "--tls passthrough: no proxy reads the request in front of Caddy, so --real-ip-header cannot apply" ;; esac
        warn "--tls passthrough: no proxy sets $REAL_IP_HEADER any more, so AGENTBOX_REAL_IP_HEADER is cleared"
        REAL_IP_HEADER=""
    fi
fi
# Caddy reads the header as well as X-Forwarded-For (and, with --cloudflare on,
# CF-Connecting-IP); naming one of those again would stop it starting, and it
# is spliced into Caddy's config, so it must be a bare header name.
case "$(printf '%s' "$REAL_IP_HEADER" | tr '[:upper:]' '[:lower:]')" in
    "") ;;
    cf-connecting-ip)
        die "--real-ip-header CF-Connecting-IP: Cloudflare's header is read with --cloudflare on (and only from Cloudflare's addresses); use that, and leave --real-ip-header empty" ;;
    x-forwarded-for)
        die "--real-ip-header X-Forwarded-For: that header is always read; leave --real-ip-header empty (behind Cloudflare, use --cloudflare on)" ;;
    x-agentbox-client-ip)
        die "--real-ip-header X-Agentbox-Client-IP: that header is agentbox's own, written by its proxy for the gate" ;;
    *[!a-z0-9-]*)
        die "--real-ip-header must be a header name (letters, digits, dashes), e.g. X-Real-IP" ;;
esac
# A password chosen on the command line is checked here, before anything is
# written or started: the gate would refuse it only after the stack is up.
if [ -n "$PASSWORD" ]; then
    [ "${#PASSWORD}" -ge 8 ] || die "--password must be at least 8 characters"
    [ "$(printf '%s' "$PASSWORD" | wc -c)" -le 72 ] || die "--password must be at most 72 bytes (bcrypt ignores the rest)"
fi
case "$SHARING" in
    on|off) ;;
    *) die "--sharing must be on or off" ;;
esac
# behind-proxy publishes plain HTTP, and its Caddy believes X-Forwarded-For
# from any private address (it expects your proxy there). On an address
# others can reach, anyone on a private network in front of it could name
# their own address to the sign-in limits, and would talk to it unencrypted.
# So loopback, unless the operator says otherwise in so many words.
if [ "$MODE" = "behind-proxy" ]; then
    case "$BIND" in
        \[*\]:*) bind_host="${BIND%%]*}"; bind_host="${bind_host#[}" ;;
        *:*)     bind_host="${BIND%:*}" ;;
        *)       bind_host="" ;;   # a bare port: Docker listens on every address
    esac
    case "$bind_host" in
        127.*|localhost|::1) ;;
        *)
            [ "$BIND_PUBLIC" = on ] || die "--bind $BIND is not a loopback address. behind-proxy serves plain HTTP and trusts X-Forwarded-For from every private address, so only your own proxy should reach it: bind 127.0.0.1:<port>, or pass --bind-public if a proxy on another host must connect (see docs/install.md)"
            warn "--bind $BIND listens beyond loopback: plain HTTP, and anyone who can reach it from a private address can set the client address the sign-in limits count. Firewall it to your proxy alone."
            ;;
    esac
fi
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
case "$BUILD" in
    ""|on|off) ;;
    *) die "AGENTBOX_BUILD must be on, off or empty" ;;
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
# Three kinds of install directory:
#   a release  — a VERSION file, unpacked from agentbox.tar.gz; images pulled
#   a checkout — a .git; images built from it (and from a clone, the old way)
#   a copy     — neither, put there by hand; used as it is, images built
# A new install is a release, unless --from-git.

# release_url <tag|""> <file>: where a release's file is; "" is the latest.
release_url() {
    local base="${RELEASE_URL:-https://github.com/jabezpauls/agentbox/releases}"
    base="${base%/}"
    if [ -z "$1" ]; then printf '%s/latest/download/%s' "$base" "$2"; else printf '%s/download/%s/%s' "$base" "$1" "$2"; fi
}
# fetch_release <tag|""> <dir>: download a release's bundle and its
# SHA256SUMS, refuse it unless they match (before anything is unpacked), and
# unpack it over <dir>, keeping .env and anything else the bundle does not
# carry. Sets RELEASE_TAG to the release unpacked. A mirror that publishes no
# checksums needs AGENTBOX_INSECURE_SKIP_VERIFY=1, said in so many words.
# (scripts/agentbox has the same function, for `agentbox update`.)
fetch_release() {
    local want="$1" dest="$2" tmp sums
    command -v curl >/dev/null 2>&1 || die "curl is required"
    command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required to check the download"
    tmp="$(mktemp -d)"
    log "Downloading agentbox ${want:-(latest release)}"
    curl -fsSL -o "$tmp/agentbox.tar.gz" "$(release_url "$want" agentbox.tar.gz)" \
        || { rm -rf "$tmp"; die "could not download $(release_url "$want" agentbox.tar.gz)"; }
    # The checksums from the same place as the bundle, checked before tar
    # reads a byte of it.
    if curl -fsSL -o "$tmp/SHA256SUMS" "$(release_url "$want" SHA256SUMS)"; then
        sums="$(grep -E ' \*?agentbox\.tar\.gz$' "$tmp/SHA256SUMS" | head -n1 | cut -d' ' -f1)"
        if [ -z "$sums" ] || [ "$sums" != "$(sha256sum "$tmp/agentbox.tar.gz" | cut -d' ' -f1)" ]; then
            rm -rf "$tmp"
            die "agentbox.tar.gz does not match the release's SHA256SUMS; not installing it"
        fi
    elif [ "${AGENTBOX_INSECURE_SKIP_VERIFY:-}" = 1 ]; then
        warn "no SHA256SUMS at $(release_url "$want" SHA256SUMS); installing unchecked (AGENTBOX_INSECURE_SKIP_VERIFY=1)"
    else
        rm -rf "$tmp"
        die "could not download $(release_url "$want" SHA256SUMS), so the release cannot be checked; not installing it. (For a mirror without checksums: AGENTBOX_INSECURE_SKIP_VERIFY=1.)"
    fi
    mkdir "$tmp/x"
    tar -xzf "$tmp/agentbox.tar.gz" -C "$tmp/x" --strip-components=1 \
        || { rm -rf "$tmp"; die "the downloaded release is not a valid archive"; }
    RELEASE_TAG="$(head -n1 "$tmp/x/VERSION" 2>/dev/null || true)"
    printf '%s' "$RELEASE_TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' \
        || { rm -rf "$tmp"; die "the downloaded release does not say which version it is"; }
    if [ -n "$want" ] && [ "$want" != "$RELEASE_TAG" ]; then
        rm -rf "$tmp"; die "asked for $want, but the download is $RELEASE_TAG"
    fi
    mkdir -p "$dest"
    # A fresh inode for every file (--remove-destination), so a script that is
    # running while it is replaced keeps reading its own copy.
    cp -R --remove-destination "$tmp/x/." "$dest/" 2>/dev/null || cp -R "$tmp/x/." "$dest/"
    rm -rf "$tmp"
}

SOURCE="copy"
if [ -n "$ENV_ONLY" ]; then
    if [ -e "$INSTALL_DIR/.git" ]; then SOURCE="checkout"; elif [ -f "$INSTALL_DIR/VERSION" ]; then SOURCE="release"; fi
elif [ "$FROM_GIT" = "true" ] && [ ! -e "$INSTALL_DIR/.git" ]; then
    [ -f "$INSTALL_DIR/docker-compose.yml" ] && die "$INSTALL_DIR already holds an install; --from-git clones into a new directory (--dir)"
    log "Cloning into $INSTALL_DIR"
    command -v git >/dev/null 2>&1 || die "git is required for --from-git"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
    SOURCE="checkout"
elif [ -e "$INSTALL_DIR/.git" ]; then
    SOURCE="checkout"
    [ -n "$RELEASE" ] && die "$INSTALL_DIR is a git checkout; check out the tag you want there instead of --version"
    if [ "$INSTALL_DIR" = "$SELF_DIR" ]; then
        log "Using the checkout at $INSTALL_DIR"
    else
        log "Updating existing install at $INSTALL_DIR"
        # A local checkout may have no upstream, or a pinned one. Failing to
        # update must not abort an otherwise valid install.
        git -C "$INSTALL_DIR" pull --ff-only \
            || warn "could not update the checkout; continuing with what is on disk"
    fi
elif [ -f "$INSTALL_DIR/VERSION" ] && [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    SOURCE="release"
    # A re-run keeps the release it has; moving to another is explicit
    # (--version here, or ./scripts/agentbox update).
    if [ -n "$RELEASE" ] && [ "$RELEASE" != "$(head -n1 "$INSTALL_DIR/VERSION")" ]; then
        fetch_release "$WANT" "$INSTALL_DIR"
    else
        log "Using agentbox $(head -n1 "$INSTALL_DIR/VERSION") at $INSTALL_DIR"
    fi
elif [ -f "$INSTALL_DIR/docker-compose.yml" ] && [ -z "$RELEASE" ]; then
    log "Using existing directory $INSTALL_DIR"
else
    # A new install (or a copy being moved onto releases with --version).
    SOURCE="release"
    fetch_release "$WANT" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# Which agentbox this is: baked into both images and reported by the System
# surface and the gate. A release says so in its VERSION file, and its images
# are pulled at that tag. Only this directory's own checkout counts, never one
# it happens to sit inside; a copy without either is "dev".
VERSION="dev"
TAG=""
if [ "$SOURCE" = "checkout" ] && command -v git >/dev/null 2>&1; then
    VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo dev)"
elif [ "$SOURCE" = "release" ]; then
    TAG="$(head -n1 VERSION)"
    VERSION="$TAG"
fi

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
        PASSWORD="$(random_password)"
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
    # AGENTBOX_CLIENT_IP_HEADER and AGENTBOX_PREVIEW_MODE are older keys, carried over above.
    managed_re="^(AGENTBOX_PASSWORD_HASH|AGENTBOX_VERSION|AGENTBOX_CLIENT_IP_HEADER|AGENTBOX_PREVIEW_MODE"
    for pair in $MANAGED; do managed_re="$managed_re|${pair%%:*}"; done
    # The release is this directory's (a checkout has none); a copy keeps
    # whatever its .env says.
    if [ -n "$TAG" ] || [ "$SOURCE" = checkout ]; then managed_re="$managed_re|AGENTBOX_TAG"; fi
    # Given in the environment, these replace what .env has.
    [ -n "${AGENTBOX_IMAGE_PREFIX:-}" ] && managed_re="$managed_re|AGENTBOX_IMAGE_PREFIX"
    [ -n "$RELEASE_URL" ] && managed_re="$managed_re|AGENTBOX_RELEASE_URL"
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
AGENTBOX_BIND_PUBLIC=$BIND_PUBLIC
AGENTBOX_EDGE_NETWORK=$EDGE_NETWORK
AGENTBOX_CERT_RESOLVER=$CERT_RESOLVER
AGENTBOX_TLS=$TLS
AGENTBOX_USER=$USERNAME
AGENTBOX_PASSWORD_HASH=$HASH_ESCAPED
AGENTBOX_SHARING=$SHARING
AGENTBOX_CLOUDFLARE=$CLOUDFLARE
AGENTBOX_REAL_IP_HEADER=$REAL_IP_HEADER
AGENTBOX_AGENTS=$AGENTS
AGENTBOX_PUBLIC_URL=$PUBLIC_URL
AGENTBOX_CPUS=$CPUS
AGENTBOX_MEMORY=$MEMORY
AGENTBOX_PROXY_CPUS=$PROXY_CPUS
AGENTBOX_PROXY_MEMORY=$PROXY_MEMORY
AGENTBOX_VERSION=$VERSION
AGENTBOX_BUILD=$BUILD
ENVFILE
# The release whose images to pull, pinned: moving to another is an explicit
# `./scripts/agentbox update`.
[ -n "$TAG" ] && printf 'AGENTBOX_TAG=%s\n' "$TAG" >> "$NEW_ENV"
# A registry mirror, or a release server other than GitHub, given in the
# environment: kept, so `agentbox update` uses the same.
case "${AGENTBOX_IMAGE_PREFIX:-}$RELEASE_URL" in
    *$'\n'*|*$'\r'*) die "AGENTBOX_IMAGE_PREFIX and AGENTBOX_RELEASE_URL may not contain a newline" ;;
esac
[ -n "${AGENTBOX_IMAGE_PREFIX:-}" ] && printf 'AGENTBOX_IMAGE_PREFIX=%s\n' "$AGENTBOX_IMAGE_PREFIX" >> "$NEW_ENV"
[ -n "$RELEASE_URL" ] && printf 'AGENTBOX_RELEASE_URL=%s\n' "$RELEASE_URL" >> "$NEW_ENV"
chmod 600 "$NEW_ENV"
mv "$NEW_ENV" .env
[ -n "$ENV_ONLY" ] && { log "Wrote .env (env-only run; nothing else done)"; exit 0; }

# --- Launch -----------------------------------------------------------------
# Traefik with TLS passed through has an overlay of its own.
OVERLAY="$MODE"
[ "$MODE" = traefik ] && [ "$TLS" = passthrough ] && OVERLAY="traefik-passthrough"
COMPOSE=(-f docker-compose.yml -f "docker-compose.$OVERLAY.yml")

# Pull the release's images (or build them here: a checkout, --build, or
# --agents other than the prebuilt pair) and start, removing any service this
# version no longer has. The same step `agentbox update` ends with.
"$INSTALL_DIR/scripts/agentbox" apply

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
printf '  Version   %s\n' "$VERSION"
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
[ -n "$REAL_IP_HEADER" ] && printf '  Client IP header %s  (your proxy must overwrite it on every request)\n' "$REAL_IP_HEADER"
printf '\n  Sign in at /login, then: Editor /vscode/   Workbench /workbench   Terminal /terminal   Shell /shell   Monitor /monitor\n'
# Day-two commands as they must be typed: an install made as root has a
# root-only .env, so its commands need sudo.
AS=""
[ "$(id -u)" = 0 ] && AS="sudo "
printf '  Two-factor is optional (Settings -> Account; see docs/install.md).\n'
# The box serves its own CLI; this is the line to run on a laptop (docs/cli.md).
printf '\n  The agentbox CLI, on your own machine (Node 20+):\n'
printf '    curl -fsSL %s/cli/install | sh\n' "${PUBLIC_URL:-https://<this box>}"
printf '    or: npm i -g @jabezpauls/agentbox && agentbox login %s\n' "${PUBLIC_URL:-https://<this box>}"
printf '\n  Installed in %s. Day to day, on this server:\n' "$INSTALL_DIR"
printf '    cd %s\n' "$INSTALL_DIR"
printf '    %s./scripts/agentbox status\n' "$AS"
printf '    %s./scripts/agentbox passwd      # change the password\n' "$AS"
printf '    %s./scripts/agentbox update      # move to the latest release\n' "$AS"
printf '\n'
