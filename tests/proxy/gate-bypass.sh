#!/usr/bin/env bash
# The gate bypass suite: the real Caddyfiles in the real Caddy image, in front
# of the real gate image, with echo servers (tests/proxy/harness.mjs) standing
# in for every port of the sandbox. For each Caddyfile it proves:
#
#  1. no unauthenticated request — any path, any path trick, any header trick,
#     any method, a WebSocket — reaches any upstream at all;
#  2. a signed-in request reaches the right upstream at the right path, and
#     neither the gate's cookies nor Authorization arrive there, for plain
#     requests and WebSocket upgrades, by session and by device token;
#  3. state-changing and WebSocket requests from another site are refused;
#  4. sign-in is rate-limited before bcrypt, keyed on the real client: forging
#     X-Forwarded-For, through the proxy or straight at the gate from inside the
#     sandbox, buys nothing; and ten failures lock the address out.
#
#   tests/proxy/gate-bypass.sh                        # both Caddyfiles
#   CADDYFILES=proxy/Caddyfile.behind-proxy tests/proxy/gate-bypass.sh
#   GATE_IMAGE=agentbox/gate:ci SKIP_BUILD=1 tests/proxy/gate-bypass.sh
#   FULL_LOCKOUT=0 tests/proxy/gate-bypass.sh         # skip the 90 s lockout run
#
# Needs Docker and curl.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CADDY_IMAGE="${CADDY_IMAGE:-caddy:2-alpine}"
NODE_IMAGE="${NODE_IMAGE:-node:22-bookworm-slim}"
GATE_IMAGE="${GATE_IMAGE:-agentbox/gate:bypass-test}"
CADDYFILES="${CADDYFILES:-$ROOT/proxy/Caddyfile.behind-proxy $ROOT/proxy/Caddyfile.standalone}"
FULL_LOCKOUT="${FULL_LOCKOUT:-1}"
USER_NAME="ci"
PASSWORD="gate-bypass-pw-1"

if [ -z "${SKIP_BUILD:-}" ]; then
    echo "building $GATE_IMAGE"
    docker build -q -t "$GATE_IMAGE" -f "$ROOT/images/gate/Dockerfile" "$ROOT" >/dev/null
fi

ID="agentbox-gate-bypass-$$"
NET="$ID-net"
ECHO="$ID-code"
GATE="$ID-gate"
CADDY="$ID-caddy"
FAILED=0
WORK="$(mktemp -d)"

cleanup() {
    docker rm -f -v "$CADDY" "$GATE" "$ECHO" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

pass() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }

docker network create "$NET" >/dev/null
# The alias `code` is the host the gate forwards every sandbox port to.
docker run -d --name "$ECHO" --network "$NET" --network-alias code \
    -v "$ROOT/tests/proxy/harness.mjs:/harness.mjs:ro" \
    "$NODE_IMAGE" node /harness.mjs >/dev/null
for _ in $(seq 1 50); do
    docker logs "$ECHO" 2>/dev/null | grep -q READY && break
    sleep 0.2
done
docker logs "$ECHO" 2>/dev/null | grep -q READY || { echo "echo harness did not start:" >&2; docker logs "$ECHO" >&2; exit 1; }

HASH="$(printf '%s\n' "$PASSWORD" | docker run --rm -i --entrypoint agentbox-gate "$GATE_IMAGE" hash-password)"

hits() { docker logs "$ECHO" 2>/dev/null | grep -c '^HIT' || true; }

# req <method> <path> [curl args...] — sets STATUS, BODY and HEADERS (a file).
req() {
    local method="$1" path="$2"; shift 2
    HEADERS="$WORK/headers"
    STATUS="$(curl -s --path-as-is -X "$method" -o "$WORK/body" -D "$HEADERS" -w '%{http_code}' \
        --max-time 10 "$@" "http://127.0.0.1:$PORT$path" || echo 000)"
    BODY="$(tr -d '\n' <"$WORK/body")"
}

header() { grep -i "^$1:" "$HEADERS" | head -n1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }

# ws <path> [curl args...] — a WebSocket handshake; sets STATUS and ECHOED
# (what the upstream saw, decoded from its X-Echo header, when it got there).
ws() {
    local path="$1"; shift
    HEADERS="$WORK/headers"
    curl -s --http1.1 -o /dev/null -D "$HEADERS" --max-time 5 \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
        -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$@" "http://127.0.0.1:$PORT$path" >/dev/null 2>&1 || true
    STATUS="$(head -n1 "$HEADERS" | awk '{print $2}')"
    ECHOED="$(header X-Echo | base64 -d 2>/dev/null || true)"
}

start_gate() {
    docker rm -f -v "$GATE" >/dev/null 2>&1 || true
    # As compose runs it: read-only, no capabilities, trusting only `proxy`.
    docker run -d --name "$GATE" --network "$NET" --network-alias gate \
        --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
        -e AGENTBOX_USER="$USER_NAME" -e AGENTBOX_PASSWORD_HASH="$HASH" -e GATE_TRUSTED_PROXIES=proxy \
        "$GATE_IMAGE" >/dev/null
}

start_caddy() {
    local file
    # A bind mount needs an absolute path; CADDYFILES may name relative ones.
    file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
    docker rm -f "$CADDY" >/dev/null 2>&1 || true
    # standalone's site address is the domain; point it at a plain listener.
    docker run -d --name "$CADDY" --network "$NET" --network-alias proxy -p 127.0.0.1::8080 \
        -v "$file:/etc/caddy/Caddyfile:ro" -e AGENTBOX_DOMAIN=":8080" \
        "$CADDY_IMAGE" >/dev/null
    PORT=""
    for _ in $(seq 1 100); do
        PORT="$(docker port "$CADDY" 8080/tcp 2>/dev/null | head -n1 | sed 's/.*://')"
        [ -n "$PORT" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/login" || true)" = 200 ] && return 0
        sleep 0.2
    done
    return 1
}

sign_in() {
    req POST /_gate/login -H "Origin: http://127.0.0.1:$PORT" -H 'Content-Type: application/json' \
        --data "{\"username\":\"$USER_NAME\",\"password\":\"$1\"}" "${@:2}"
}

for CADDYFILE in $CADDYFILES; do
    printf '\n== %s\n' "$CADDYFILE"
    start_gate
    start_caddy "$CADDYFILE" || { fail "caddy or the gate did not start"; docker logs "$CADDY" >&2; docker logs "$GATE" >&2; continue; }
    ORIGIN="http://127.0.0.1:$PORT"
    TOKEN32="0123456789abcdef0123456789abcdef"

    # --- 1. Nothing unauthenticated reaches the sandbox -----------------------
    before="$(hits)"
    for p in / /vscode/ /vscode/static/x.js /terminal/ /terminal/ws /terminal/token /shell/ /monitor/ \
        /workbench/ /workbench/api/health /workbench/preview/8080/ /api/rpc "/s/$TOKEN32/" /a/abc/ /app/3000/; do
        req GET "$p" -H 'Accept: text/html' -H 'Sec-Fetch-Mode: navigate'
        if [ "$STATUS" = 302 ] && [[ "$(header Location)" == /login\?next=* ]]; then :; else fail "navigation to $p: $STATUS"; fi
        req GET "$p" -H 'Accept: application/json'
        [ "$STATUS" = 401 ] || fail "fetch of $p: $STATUS"
        req POST "$p" -H "Origin: $ORIGIN" --data '{}'
        [ "$STATUS" = 401 ] || fail "POST $p: $STATUS"
    done
    pass "every route sends a page load to /login and anything else a 401"

    # Path tricks: forms that one parser normalises and another does not. The
    # gate refuses them (400) before routing; whatever Caddy did first, none may
    # reach an upstream unauthenticated.
    variants=(
        "/login/../vscode/" "/login/..%2f..%2fvscode/" "/login/%2e%2e/terminal/" "/login/%2E%2E/terminal/"
        "/login/assets/../../terminal/" "/login/assets/..%2f..%2f..%2fshell/" "/login/assets/%2e%2e/%2e%2e/monitor/"
        "/_gate/../vscode/" "/_gate/login/../../workbench/api/health" "/_gate/..%5cterminal/" "/_gate/login%2f..%2f..%2fvscode/"
        "/cli/../shell/" "/cli/..%2fvscode/" "/cli/install/../../terminal/"
        "//vscode/" "//terminal/ws" "/./terminal/" "/%2e/vscode/" "/%2e%2e/vscode/" "/login;/../vscode/"
        "/login\\..\\vscode/" "/settings/devices/../../vscode/" "/login%00/../vscode/" "/LOGIN/../vscode/"
        "/vscode/../login" "/terminal/..;/vscode/"
    )
    for p in "${variants[@]}"; do
        req GET "$p" -H 'Accept: application/json'
        case "$STATUS" in
            400|401|404) ;;
            *) fail "path trick $p -> $STATUS $BODY" ;;
        esac
    done
    pass "${#variants[@]} path tricks answered 400/401/404"

    # Header tricks: nothing a client can say about itself opens a door.
    B64="$(printf '%s:%s' "$USER_NAME" "$PASSWORD" | base64)"
    header_tricks=(
        "Authorization: Basic $B64"
        "Authorization: Bearer abx_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        "Cookie: __Host-agentbox=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        "Cookie: __host-agentbox=x; __Secure-agentbox-app=y"
        "X-Agentbox-Public: 1"
        "X-Forwarded-For: 127.0.0.1"
        "X-Original-URL: /login"
        "X-Rewrite-URL: /login"
        "Host: gate:7900"
    )
    for h in "${header_tricks[@]}"; do
        for p in /vscode/ /terminal/ /workbench/api/health; do
            req GET "$p" -H "$h" -H 'Accept: application/json'
            [ "$STATUS" = 401 ] || fail "header trick '$h' on $p -> $STATUS"
        done
    done
    pass "${#header_tricks[@]} header tricks (the old Basic credentials included) open nothing"

    # Odd request targets. Caddy may answer `OPTIONS *` itself; either way the
    # hit count below is what matters.
    req OPTIONS / --request-target '*'
    case "$STATUS" in 200|400|401|404) ;; *) fail "OPTIONS * -> $STATUS" ;; esac
    req GET / --request-target "http://code:8080/"
    case "$STATUS" in 400|401|404) ;; *) fail "absolute-form target -> $STATUS" ;; esac
    ws /terminal/ws -H "Origin: $ORIGIN"
    [ "$STATUS" = 401 ] || fail "unauthenticated WebSocket -> $STATUS"
    ws /vscode/stable-x -H "Origin: $ORIGIN" -H "Authorization: Basic $B64"
    [ "$STATUS" = 401 ] || fail "WebSocket with the old Basic credentials -> $STATUS"

    after="$(hits)"
    if [ "$after" = "$before" ]; then
        pass "no unauthenticated request reached any upstream ($((after - before)) hits)"
    else
        fail "unauthenticated requests reached an upstream:"
        docker logs "$ECHO" 2>/dev/null | grep '^HIT' | tail -n "$((after - before))" >&2
    fi

    # --- 2. Signed in: the right place, and no credentials on arrival ---------
    sign_in "$PASSWORD"
    SESSION="$(grep -i '^set-cookie: __Host-agentbox=' "$HEADERS" | head -n1 | sed 's/^[^:]*: //; s/;.*//' | tr -d '\r')"
    if [ "$STATUS" = 200 ] && [ -n "$SESSION" ]; then pass "signs in through the proxy"; else fail "sign-in: $STATUS $BODY"; continue; fi
    SETC="$(grep -i '^set-cookie: __Host-agentbox=' "$HEADERS" | head -n1)"
    for attr in 'Path=/' HttpOnly Secure 'SameSite=Lax'; do
        [[ "$SETC" == *"$attr"* ]] || fail "session cookie lacks $attr: $SETC"
    done

    routes=(
        "/vscode/|8080|/" "/vscode/static/out/main.js?v=1|8080|/static/out/main.js?v=1"
        "/terminal/|7681|/terminal/" "/terminal/token|7681|/terminal/token" "/shell/|7683|/shell/"
        "/monitor/|7682|/monitor/" "/workbench/api/health|7800|/workbench/api/health" "/|7800|/"
        "/api/files/list?path=%2Fworkspace|7800|/api/files/list?path=%2Fworkspace"
    )
    for r in "${routes[@]}"; do
        IFS='|' read -r p port want <<<"$r"
        req GET "$p" -H "Cookie: theme=dark; $SESSION; __Secure-agentbox-app=grant; keep=1" \
            -H "Authorization: Basic $B64" -H 'Proxy-Authorization: Basic eA==' -H 'X-Agentbox-Public: 1'
        if [ "$STATUS" != 200 ]; then fail "$p -> $STATUS"; continue; fi
        [[ "$BODY" == *"\"port\":$port,"* ]] || fail "$p reached the wrong upstream: $BODY"
        [[ "$BODY" == *"\"url\":\"$want\""* ]] || fail "$p arrived as the wrong path: $BODY"
        case "$BODY" in
            *agentbox-app*|*__Host-agentbox*|*__host-agentbox*|*'"authorization"'*|*proxy-authorization*|*x-agentbox-public*)
                fail "a credential reached the sandbox via $p: $BODY" ;;
        esac
        [[ "$BODY" == *'"cookie":"theme=dark; keep=1"'* ]] || fail "the app's own cookies did not survive via $p: $BODY"
    done
    pass "signed-in requests reach each service at the right path, with no front-door credential"

    req GET /vscode -H "Cookie: $SESSION"
    { [ "$STATUS" = 308 ] && [ "$(header Location)" = /vscode/ ]; } || fail "/vscode -> $STATUS $(header Location)"

    ws /terminal/ws -H "Cookie: $SESSION; keep=1" -H "Origin: $ORIGIN" -H "Authorization: Basic $B64"
    if [ "$STATUS" = 101 ] && [[ "$ECHOED" == *'"port":7681'* ]]; then
        case "$ECHOED" in
            *__Host-agentbox*|*'"authorization"'*) fail "a credential reached ttyd on the upgrade: $ECHOED" ;;
            *) pass "a WebSocket reaches ttyd with the session stripped" ;;
        esac
    else
        fail "signed-in WebSocket: $STATUS $ECHOED"
    fi
    ws /vscode/stable-x -H "Cookie: $SESSION" -H "Origin: $ORIGIN"
    { [ "$STATUS" = 101 ] && [[ "$ECHOED" == *'"url":"/stable-x"'* ]]; } || fail "editor WebSocket: $STATUS $ECHOED"

    # --- 3. Another site cannot use the session ------------------------------
    before="$(hits)"
    req POST /workbench/api/rpc -H "Cookie: $SESSION" -H 'Origin: https://evil.example' --data '{}'
    [ "$STATUS" = 403 ] || fail "cross-site POST -> $STATUS"
    req POST /workbench/api/rpc -H "Cookie: $SESSION" --data '{}'
    [ "$STATUS" = 403 ] || fail "POST without Origin -> $STATUS"
    ws /terminal/ws -H "Cookie: $SESSION" -H 'Origin: https://evil.example'
    [ "$STATUS" = 403 ] || fail "cross-site WebSocket -> $STATUS"
    ws /terminal/ws -H "Cookie: $SESSION" -H 'Origin: null'
    [ "$STATUS" = 403 ] || fail "WebSocket from an opaque origin -> $STATUS"
    if [ "$(hits)" = "$before" ]; then
        pass "cross-site requests and WebSockets are refused before the sandbox"
    else
        fail "a cross-site request reached an upstream"
    fi
    req POST /workbench/api/rpc -H "Cookie: $SESSION" -H "Origin: $ORIGIN" --data '{}'
    [ "$STATUS" = 200 ] || fail "same-origin POST -> $STATUS"

    # --- a device token, end to end -------------------------------------------
    req POST /_gate/device/start -H 'Content-Type: application/json' --data '{"name":"bypass-suite"}'
    DEVICE="$(printf '%s' "$BODY" | sed -n 's/.*"deviceCode":"\([^"]*\)".*/\1/p')"
    USERCODE="$(printf '%s' "$BODY" | sed -n 's/.*"userCode":"\([^"]*\)".*/\1/p')"
    req POST /_gate/device/approve -H "Cookie: $SESSION" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
        --data "{\"userCode\":\"$USERCODE\"}"
    [ "$STATUS" = 200 ] || fail "approve: $STATUS $BODY"
    req POST /_gate/device/poll -H 'Content-Type: application/json' --data "{\"deviceCode\":\"$DEVICE\"}"
    TOKEN="$(printf '%s' "$BODY" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
    if [ -n "$TOKEN" ]; then
        req GET /shell/ -H "Authorization: Bearer $TOKEN"
        if [ "$STATUS" = 200 ] && [[ "$BODY" == *'"port":7683'* ]] && [[ "$BODY" != *'"authorization"'* ]]; then
            pass "a device token opens the box and is stripped on the way in"
        else
            fail "device token: $STATUS $BODY"
        fi
        ws /terminal/ws -H "Authorization: Bearer $TOKEN"
        { [ "$STATUS" = 101 ] && [[ "$ECHOED" != *'"authorization"'* ]]; } || fail "device token WebSocket: $STATUS $ECHOED"
    else
        fail "device login issued no token: $BODY"
    fi

    # --- 4. Rate limits and lockout, keyed on the real client ----------------
    # A restart forgives the sign-in above: limits live in the gate's memory.
    docker restart "$GATE" >/dev/null
    for _ in $(seq 1 100); do
        [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/login" || true)" = 200 ] && break
        sleep 0.2
    done
    # Through the proxy, forging X-Forwarded-For and CF-Connecting-IP each time:
    # Caddy replaces the first, the gate ignores the second in this mode.
    codes=""
    for i in 1 2 3 4 5; do
        sign_in wrong-password -H "X-Forwarded-For: 203.0.113.$i" -H "CF-Connecting-IP: 203.0.113.$i"
        codes="$codes $STATUS"
    done
    sign_in "$PASSWORD" -H 'X-Forwarded-For: 203.0.113.99' -H 'CF-Connecting-IP: 203.0.113.99'
    if [ "$codes" = " 401 401 401 401 401" ] && [ "$STATUS" = 429 ] && [ -n "$(header Retry-After)" ]; then
        pass "the sixth sign-in in a minute is refused — right password, forged addresses and all"
    else
        fail "rate limit through the proxy: [$codes] then $STATUS $BODY"
    fi
    [[ "$BODY" == *'"error":"rate"'* ]] || fail "rate-limited answer: $BODY"

    # The limit is this client's, not everyone's: a second client through the
    # same proxy — whose address the gate learns from the proxy — signs in.
    other="$(docker exec "$ECHO" node /harness.mjs proxied 1 "$PASSWORD")"
    if [ "$other" = 200 ]; then
        pass "another client through the proxy is unaffected (the gate keys on the proxy's report)"
    else
        fail "a second client through the proxy got $other"
    fi

    # Straight at the gate from inside the sandbox, forging the same headers.
    # That container's sign-in just above is the first of its five a minute, so
    # four failures fill the window and the right password comes too late.
    direct="$(docker exec "$ECHO" node /harness.mjs direct 5 "$PASSWORD")"
    if [ "$direct" = "401 401 401 401 429" ]; then
        pass "a sandbox process calling the gate directly cannot claim another address"
    else
        fail "direct from the sandbox: $direct"
    fi

    if [ "$FULL_LOCKOUT" = 1 ]; then
        # Ten consecutive failures lock the address out for 15 minutes; the
        # limits space them out, so this takes about a minute and a half.
        failures=5
        while [ "$failures" -lt 10 ]; do
            sign_in wrong-password
            if [ "$STATUS" = 429 ]; then
                sleep "$(header Retry-After)"
            elif [ "$STATUS" = 401 ]; then
                failures=$((failures + 1))
            else
                fail "unexpected answer during lockout run: $STATUS $BODY"; break
            fi
        done
        sign_in "$PASSWORD"
        if [ "$STATUS" = 429 ] && [[ "$BODY" == *'"error":"locked"'* ]] && [ "$(header Retry-After)" -ge 890 ]; then
            pass "ten failures lock the address out for 15 minutes, right password or not"
        else
            fail "lockout: $STATUS $BODY (Retry-After $(header Retry-After))"
        fi
        # Only the first Caddyfile pays for this.
        FULL_LOCKOUT=0
    fi
done

printf '\n'
if [ "$FAILED" -ne 0 ]; then
    echo "gate bypass check FAILED" >&2
    exit 1
fi
echo "gate bypass check passed"
