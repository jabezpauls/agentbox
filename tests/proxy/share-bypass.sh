#!/usr/bin/env bash
# Regression check for the /s/ authentication bypass (C1).
#
# Stands up the real Caddyfile in the real Caddy image in front of the real
# Workbench bridge, then fires encoded and dot-segment variants of /s/<token>/
# without credentials. None may reach /workbench, the editor or a ttyd shell;
# a clean share link must still open with no login; the login must still guard
# everything else; and a client cannot claim the public branch by sending the
# marker header itself.
#
#   tests/proxy/share-bypass.sh                    # both Caddyfiles
#   CADDYFILES=proxy/Caddyfile.behind-proxy tests/proxy/share-bypass.sh
#   CADDYFILES=/path/to/old/Caddyfile tests/proxy/share-bypass.sh   # prove it fails
#
# Needs Docker, and the bridge built: (cd web && npm ci && npm run build -w bridge).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CADDY_IMAGE="${CADDY_IMAGE:-caddy:2-alpine}"
NODE_IMAGE="${NODE_IMAGE:-node:22-bookworm-slim}"
CADDYFILES="${CADDYFILES:-$ROOT/proxy/Caddyfile.behind-proxy $ROOT/proxy/Caddyfile.standalone}"
USER_NAME="ci"
PASSWORD="c1-regression-pw"

[ -f "$ROOT/web/bridge/dist/bridge/src/app.js" ] \
    || { echo "build the bridge first: (cd web && npm ci && npm run build -w bridge)" >&2; exit 2; }

ID="agentbox-c1-$$"
NET="$ID-net"
BRIDGE="$ID-code"
CADDY="$ID-caddy"
FAILED=0

cleanup() {
    docker rm -f "$CADDY" "$BRIDGE" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$NET" >/dev/null
# The alias `code` is the hostname every Caddyfile proxies to.
docker run -d --name "$BRIDGE" --network "$NET" --network-alias code \
    -v "$ROOT/web:/web:ro" -v "$ROOT/tests/proxy/harness.mjs:/harness.mjs:ro" \
    "$NODE_IMAGE" node /harness.mjs >/dev/null

TOKEN=""
for _ in $(seq 1 50); do
    TOKEN="$(docker logs "$BRIDGE" 2>/dev/null | sed -n 's/^TOKEN=//p' | head -n1)"
    [ -n "$TOKEN" ] && break
    sleep 0.2
done
[ -n "$TOKEN" ] || { echo "bridge harness did not start:" >&2; docker logs "$BRIDGE" >&2; exit 1; }

HASH="$(docker run --rm "$CADDY_IMAGE" caddy hash-password --plaintext "$PASSWORD")"

pass() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }

# request <path> [curl args...] — prints "<status> <body>"
request() {
    local p="$1"; shift
    local body status
    body="$(mktemp)"
    status="$(curl -s --path-as-is -o "$body" -w '%{http_code}' "$@" "http://127.0.0.1:$PORT$p" || echo 000)"
    printf '%s %s' "$status" "$(tr -d '\n' <"$body")"
    rm -f "$body"
}

# Markers of the places an unauthenticated request must never reach.
leaked() {
    case "$1" in
        *EDITOR-STUB*|*TTYD-STUB*|*'"herdr"'*) return 0 ;;
        *) return 1 ;;
    esac
}

for CADDYFILE in $CADDYFILES; do
    printf '\n== %s\n' "$CADDYFILE"
    docker rm -f "$CADDY" >/dev/null 2>&1 || true
    # standalone's site address is the domain; point it at a plain listener.
    docker run -d --name "$CADDY" --network "$NET" -p 127.0.0.1::8080 \
        -v "$CADDYFILE:/etc/caddy/Caddyfile:ro" \
        -e AGENTBOX_DOMAIN=":8080" -e AGENTBOX_USER="$USER_NAME" \
        -e AGENTBOX_PASSWORD_HASH="$HASH" -e AGENTBOX_PREVIEW_DOMAIN= \
        "$CADDY_IMAGE" >/dev/null
    PORT=""
    for _ in $(seq 1 50); do
        PORT="$(docker port "$CADDY" 8080/tcp 2>/dev/null | head -n1 | sed 's/.*://')"
        [ -n "$PORT" ] && curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
        sleep 0.2
    done
    [ -n "$PORT" ] || { fail "caddy did not start"; docker logs "$CADDY" >&2; continue; }

    # 1. The share opens with no login.
    out="$(request "/s/$TOKEN/hello")"
    if [ "${out%% *}" = 200 ] && [[ "$out" == *"SHARED-APP /hello"* ]]; then
        pass "clean share link opens without a login"
    else
        fail "clean share link: $out"
    fi

    # 2. The login still guards the Workbench and the editor.
    for p in /workbench/api/health / /terminal/ "/workbench/preview/8080/"; do
        out="$(request "$p")"
        if [ "${out%% *}" = 401 ]; then pass "login required: $p"; else fail "not guarded: $p -> $out"; fi
    done

    # 3. Encoded and dot-segment variants: none may reach a private route.
    variants=(
        "/workbench/preview/8080/../../../s/$TOKEN/"
        "/workbench/preview/7681/..%2f..%2f..%2fs/$TOKEN/"
        "/workbench/preview/8080/%2e%2e/%2e%2e/%2e%2e/s/$TOKEN/"
        "/workbench/preview/8080/%2E%2E/%2E%2E/%2E%2E/s/$TOKEN/"
        "/workbench/api/health%2f..%2f..%2fs%2f$TOKEN/"
        "/workbench/preview/8080%5c..%5c..%5cs/$TOKEN/"
        "//workbench/preview/8080/../../s/$TOKEN/"
        "/./workbench/api/health/../../s/$TOKEN/"
        "/s/$TOKEN/../../workbench/api/health"
        "/s/$TOKEN/../../"
        "/s/$TOKEN/../../terminal/"
        "/s/$TOKEN/%2e%2e/%2e%2e/"
        "/s/$TOKEN/..%2f..%2fworkbench/preview/8080/"
        "/s/$TOKEN/..%5c..%5cworkbench/api/health"
        "/s/$TOKEN//../../workbench/api/health"
        "/s/$TOKEN;/../../workbench/api/health"
        "/s/$TOKEN/.."
        "/s/$TOKEN/%2e%2e"
    )
    for p in "${variants[@]}"; do
        out="$(request "$p")"
        if leaked "$out"; then
            fail "BYPASS: $p -> $out"
        elif [ "${out%% *}" = 200 ] && [[ "$out" != *SHARED-APP* ]]; then
            fail "unexpected 200: $p -> $out"
        else
            pass "no bypass (${out%% *}): $p"
        fi
    done

    # 4. A client cannot mark itself public.
    out="$(request /workbench/api/health -H 'X-Agentbox-Public: 1')"
    if [ "${out%% *}" = 401 ]; then pass "spoofed marker without login still needs the login"; else fail "spoofed marker: $out"; fi
    out="$(request /workbench/api/health -u "$USER_NAME:$PASSWORD" -H 'X-Agentbox-Public: 1')"
    if [ "${out%% *}" = 200 ] && [[ "$out" == *'"herdr"'* ]]; then
        pass "a signed-in request with a spoofed marker has it stripped and works"
    else
        fail "spoofed marker was not stripped for a signed-in request: $out"
    fi

    # 5. The login itself works.
    out="$(request /workbench/api/health -u "$USER_NAME:$PASSWORD")"
    if [ "${out%% *}" = 200 ]; then pass "signed-in request reaches the Workbench"; else fail "signed-in: $out"; fi
done

printf '\n'
if [ "$FAILED" -ne 0 ]; then
    echo "C1 regression check FAILED" >&2
    exit 1
fi
echo "C1 regression check passed"
