#!/usr/bin/env bash
# The gate bypass suite: the real Caddyfiles in the real Caddy image, in front
# of the real gate image, with echo servers (tests/proxy/harness.mjs) standing
# in for every port of the sandbox, wired as compose wires them: the proxy and
# the gate on a `front` network of their own, the gate and the sandbox on
# `internal`, and the proxy on an `edge` network for whatever fronts it. For
# each Caddyfile it proves:
#
#  1. no unauthenticated request — any path, any path trick, any header trick,
#     any method, a WebSocket, a service worker's script — reaches any upstream;
#  2. a signed-in request reaches the right upstream at the right path, and
#     neither the gate's cookies nor Authorization arrive there, for plain
#     requests and WebSocket upgrades, by session and by device token; no
#     service worker outside the editor, and no Service-Worker-Allowed but
#     the editor's own, moved under /vscode/;
#  3. state-changing and WebSocket requests from another site are refused;
#  4. sign-in is rate-limited before bcrypt, keyed on an address the client
#     cannot choose: the sandbox cannot even reach the proxy; forged headers
#     from a peer the proxy does not trust change nothing, while a proxy it
#     does trust is believed; straight at the gate from the sandbox, forged
#     headers buy nothing; and ten failures lock the address out.
#
# Then, once, traefik mode behind Cloudflare with a real Traefik: a client that
# reaches Traefik directly and forges CF-Connecting-IP and X-Forwarded-For is
# keyed on its own address, while a request through (a stand-in for)
# Cloudflare's edge is keyed on the CF-Connecting-IP Cloudflare sets.
#
#   tests/proxy/gate-bypass.sh                        # everything
#   CADDYFILES=proxy/Caddyfile.behind-proxy tests/proxy/gate-bypass.sh
#   GATE_IMAGE=agentbox/gate:ci SKIP_BUILD=1 tests/proxy/gate-bypass.sh
#   FULL_LOCKOUT=0 tests/proxy/gate-bypass.sh         # skip the 90 s lockout run
#   TRAEFIK=0 tests/proxy/gate-bypass.sh              # skip the traefik section
#
# Needs Docker and curl.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CADDY_IMAGE="${CADDY_IMAGE:-caddy:2-alpine}"
NODE_IMAGE="${NODE_IMAGE:-node:22-bookworm-slim}"
TRAEFIK_IMAGE="${TRAEFIK_IMAGE:-traefik:v3.1}"
GATE_IMAGE="${GATE_IMAGE:-agentbox/gate:bypass-test}"
CADDYFILES="${CADDYFILES:-$ROOT/proxy/Caddyfile.behind-proxy $ROOT/proxy/Caddyfile.standalone}"
FULL_LOCKOUT="${FULL_LOCKOUT:-1}"
RUN_TRAEFIK="${TRAEFIK:-1}"
USER_NAME="ci"
PASSWORD="gate-bypass-pw-1"

if [ -z "${SKIP_BUILD:-}" ]; then
    echo "building $GATE_IMAGE"
    docker build -q -t "$GATE_IMAGE" -f "$ROOT/images/gate/Dockerfile" "$ROOT" >/dev/null
fi

ID="agentbox-gate-bypass-$$"
NET_FRONT="$ID-front"
NET_INTERNAL="$ID-internal"
NET_EDGE="$ID-edge"
ECHO="$ID-code"
GATE="$ID-gate"
CADDY="$ID-caddy"
TRAEFIK_C="$ID-traefik"
FAILED=0
WORK="$(mktemp -d)"

cleanup() {
    docker rm -f -v "$TRAEFIK_C" "$CADDY" "$GATE" "$ECHO" >/dev/null 2>&1 || true
    for n in "$NET_FRONT" "$NET_INTERNAL" "$NET_EDGE"; do docker network rm "$n" >/dev/null 2>&1 || true; done
    rm -rf "$WORK"
}
trap cleanup EXIT

pass() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }

docker network create "$NET_FRONT" >/dev/null
docker network create "$NET_INTERNAL" >/dev/null
# The edge gets a known subnet, so stand-ins for a trusted proxy (and for
# Cloudflare) can have addresses the test trust files name.
EDGE=""
for o in 213 214 215 216 217 218; do
    if docker network create --subnet "10.$o.77.0/24" "$NET_EDGE" >/dev/null 2>&1; then EDGE="10.$o.77"; break; fi
done
[ -n "$EDGE" ] || { echo "could not create the edge network" >&2; exit 1; }
FRONT_PROXY_IP="$EDGE.10"   # a trusted reverse proxy in front of Caddy (behind-proxy)
TRAEFIK_IP="$EDGE.11"
CF_EDGE_IP="$EDGE.20"       # a stand-in for a Cloudflare edge address

# The sandbox: the alias `code` is the host the gate forwards every port to.
# On `internal` only, like every sandbox service.
docker run -d --name "$ECHO" --network "$NET_INTERNAL" --network-alias code \
    -v "$ROOT/tests/proxy/harness.mjs:/harness.mjs:ro" \
    "$NODE_IMAGE" node /harness.mjs >/dev/null
for _ in $(seq 1 50); do
    docker logs "$ECHO" 2>/dev/null | grep -q READY && break
    sleep 0.2
done
docker logs "$ECHO" 2>/dev/null | grep -q READY || { echo "echo harness did not start:" >&2; docker logs "$ECHO" >&2; exit 1; }

HASH="$(printf '%s\n' "$PASSWORD" | docker run --rm -i --entrypoint agentbox-gate "$GATE_IMAGE" hash-password)"

# Trust files for the spoofing checks: the production ones' shape, with the
# ranges narrowed to the stand-ins above (a test cannot produce a public client
# address, and the production files trust every private one).
TRUST="$WORK/trust"
mkdir -p "$TRUST"
cp "$ROOT"/proxy/trust/*.caddy "$TRUST/"
cat > "$TRUST/test-front-proxy.caddy" <<EOF
trusted_proxies static $FRONT_PROXY_IP/32
client_ip_headers X-Forwarded-For
trusted_proxies_strict
EOF
cat > "$TRUST/test-traefik-cloudflare.caddy" <<EOF
trusted_proxies static $TRAEFIK_IP/32 $CF_EDGE_IP/32
client_ip_headers X-Forwarded-For CF-Connecting-IP
trusted_proxies_strict
EOF

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

# client <ip|-> <base-url> <n> <password> [Header=value ...] — sign-ins from a
# container on the edge network, at a fixed address or any.
client() {
    local ip="$1"; shift
    local at=()
    [ "$ip" = - ] || at=(--ip "$ip")
    docker run --rm --network "$NET_EDGE" "${at[@]}" -v "$ROOT/tests/proxy/harness.mjs:/harness.mjs:ro" \
        "$NODE_IMAGE" node /harness.mjs signins "$@"
}

start_gate() {
    docker rm -f -v "$GATE" >/dev/null 2>&1 || true
    # As compose runs it: read-only, no capabilities, on `front` (to hear the
    # proxy) and `internal` (to reach the sandbox), trusting only `proxy`.
    docker create --name "$GATE" --network "$NET_FRONT" --network-alias gate \
        --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
        -e AGENTBOX_USER="$USER_NAME" -e AGENTBOX_PASSWORD_HASH="$HASH" -e GATE_TRUSTED_PROXIES=proxy \
        "$GATE_IMAGE" >/dev/null
    # Compose names a service on every network it joins; so does this.
    docker network connect --alias gate "$NET_INTERNAL" "$GATE"
    docker start "$GATE" >/dev/null
}

wait_for() {
    for _ in $(seq 1 100); do
        [ "$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)" = 200 ] && return 0
        sleep 0.2
    done
    return 1
}

# start_caddy <Caddyfile> <trust name> — the proxy on `front` and `edge`.
start_caddy() {
    local file
    # A bind mount needs an absolute path; CADDYFILES may name relative ones.
    file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
    docker rm -f "$CADDY" >/dev/null 2>&1 || true
    # standalone's site address is the domain; point it at a plain listener.
    docker create --name "$CADDY" --network "$NET_FRONT" --network-alias proxy -p 127.0.0.1::8080 \
        -v "$file:/etc/caddy/Caddyfile:ro" -v "$TRUST:/etc/caddy/trust:ro" \
        -e AGENTBOX_DOMAIN=":8080" -e AGENTBOX_TRUST="$2" -e AGENTBOX_REAL_IP_HEADER= \
        "$CADDY_IMAGE" >/dev/null
    docker network connect --alias proxy "$NET_EDGE" "$CADDY"
    docker start "$CADDY" >/dev/null
    PORT=""
    for _ in $(seq 1 100); do
        PORT="$(docker port "$CADDY" 8080/tcp 2>/dev/null | head -n1 | sed 's/.*://')"
        [ -n "$PORT" ] && break
        sleep 0.2
    done
    [ -n "$PORT" ] && wait_for "http://127.0.0.1:$PORT/login"
}

# Restart the gate: it forgives every sign-in so far (limits live in its
# memory) and resolves the proxy's current address as it starts.
fresh_gate() {
    docker restart "$GATE" >/dev/null
    wait_for "http://127.0.0.1:$PORT/login"
}

sign_in() {
    req POST /_gate/login -H "Origin: http://127.0.0.1:$PORT" -H 'Content-Type: application/json' \
        --data "{\"username\":\"$USER_NAME\",\"password\":\"$1\"}" "${@:2}"
}

# The production trust a Caddyfile runs with in compose.
production_trust() {
    case "$1" in
        *standalone*) echo standalone-off ;;
        *) echo proxied-off ;;
    esac
}

for CADDYFILE in $CADDYFILES; do
    printf '\n== %s\n' "$CADDYFILE"
    start_gate
    start_caddy "$CADDYFILE" "$(production_trust "$CADDYFILE")" \
        || { fail "caddy or the gate did not start"; docker logs "$CADDY" >&2; docker logs "$GATE" >&2; continue; }
    ORIGIN="http://127.0.0.1:$PORT"
    TOKEN32="0123456789abcdef0123456789abcdef"

    # --- 1. Nothing unauthenticated reaches the sandbox -----------------------
    before="$(hits)"
    for p in / /vscode/ /vscode/static/x.js /terminal/ /terminal/ws /terminal/token /shell/ /monitor/ \
        /workbench/ /api/health /preview/8080/ /api/rpc "/s/$TOKEN32/" /a/abc/ /app/3000/; do
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
        "/_gate/../vscode/" "/_gate/login/../../api/health" "/_gate/..%5cterminal/" "/_gate/login%2f..%2f..%2fvscode/"
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

    # The CLI's two files are open to anyone, served by the gate itself (the
    # install script naming this box); nothing else under /cli is.
    req GET /cli/install
    { [ "$STATUS" = 200 ] && [[ "$BODY" == *"BOX='$ORIGIN'"* ]]; } || fail "the install script: $STATUS"
    req GET /cli/agentbox.mjs
    { [ "$STATUS" = 200 ] && [[ "$BODY" == '#!/usr/bin/env node'* ]]; } || fail "the CLI bundle: $STATUS"
    for p in /cli /cli/ /cli/other /cli/install/x /cli/agentbox.mjs.map /cli/Install; do
        req GET "$p" -H 'Accept: application/json'
        [ "$STATUS" = 401 ] || fail "GET $p without a session: $STATUS"
    done
    pass "the CLI's two files are served to anyone, and nothing else under /cli is"

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
        for p in /vscode/ /terminal/ /api/health; do
            req GET "$p" -H "$h" -H 'Accept: application/json'
            [ "$STATUS" = 401 ] || fail "header trick '$h' on $p -> $STATUS"
        done
    done
    pass "${#header_tricks[@]} header tricks (the old Basic credentials included) open nothing"

    # The WebDAV mount lets filename characters through the path guard (under
    # /api/dav/ only its prefix is judged), but it is behind sign-in all the
    # same; the editor channel is not served from outside at all.
    for p in "/api/dav/a;b" "/api/dav/a%5Cb" "/api/dav/..%2f..%2fvscode/" "/api/dav/%2e%2e/%2e%2e/terminal/" \
        "/api/dav/../../vscode/" "/api/dav/..%5c..%5cshell/" "/api/davx;y" "/ws/editor" "/ws/editor/x"; do
        req PROPFIND "$p" -H 'Depth: 0'
        case "$STATUS" in 400|401|404) ;; *) fail "unauthenticated PROPFIND $p -> $STATUS $BODY" ;; esac
        req PUT "$p" --data 'x'
        case "$STATUS" in 400|401|404) ;; *) fail "unauthenticated PUT $p -> $STATUS $BODY" ;; esac
    done
    ws /ws/editor -H "Origin: $ORIGIN"
    [ "$STATUS" = 404 ] || fail "unauthenticated editor-channel WebSocket -> $STATUS"

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
        "/monitor/|7682|/monitor/" "/api/health|7800|/api/health" "/|7800|/"
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
    req POST /api/rpc -H "Cookie: $SESSION" -H 'Origin: https://evil.example' --data '{}'
    [ "$STATUS" = 403 ] || fail "cross-site POST -> $STATUS"
    req POST /api/rpc -H "Cookie: $SESSION" --data '{}'
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
    req POST /api/rpc -H "Cookie: $SESSION" -H "Origin: $ORIGIN" --data '{}'
    [ "$STATUS" = 200 ] || fail "same-origin POST -> $STATUS"

    # --- a device token, end to end (approving needs the password again) -------
    req POST /_gate/device/start -H 'Content-Type: application/json' --data '{"name":"bypass-suite"}'
    DEVICE="$(printf '%s' "$BODY" | sed -n 's/.*"deviceCode":"\([^"]*\)".*/\1/p')"
    USERCODE="$(printf '%s' "$BODY" | sed -n 's/.*"userCode":"\([^"]*\)".*/\1/p')"
    req POST /_gate/device/approve -H "Cookie: $SESSION" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
        --data "{\"userCode\":\"$USERCODE\",\"password\":\"$PASSWORD\"}"
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

    # --- the WebDAV mount and the editor channel ---------------------------------
    # What `agentbox mount` sends: a device token, and names with ; or a
    # backslash. Under /api/dav/ the gate judges only the prefix, so each path
    # — including ones that try to climb out — must arrive at the bridge
    # exactly as sent, and at no other upstream. (Caddy writes a percent
    # escape's hex in capitals on the way through, which names the same bytes;
    # the gate itself forwards the path untouched, as its unit tests show.)
    if [ -n "$TOKEN" ]; then
        ok=1
        for p in "/api/dav/a;b.txt" "/api/dav/a%3Bb%5Cc" "/api/dav/dir%20x/50%25.txt" "/api/dav/..%2f..%2fvscode/" \
            "/api/dav/%2e%2e/%2e%2e/terminal/" "/api/dav/../../vscode/" "/api/dav/..%5c..%5cshell/"; do
            want="$(printf '%s' "$p" | sed -E 's/%([0-9a-fA-F]{2})/%\U\1/g')"
            req PROPFIND "$p" -H "Authorization: Bearer $TOKEN" -H 'Depth: 0'
            if [ "$STATUS" = 200 ] && [[ "$BODY" == *'"port":7800,'* ]] && [[ "$BODY" == *"\"url\":\"$want\""* ]]; then :; else
                fail "WebDAV $p -> $STATUS $BODY"; ok=0
            fi
            case "$BODY" in *'"authorization"'*) fail "the token reached the sandbox via $p"; ok=0 ;; esac
        done
        [ "$ok" = 0 ] || pass "WebDAV names reach the bridge exactly as sent, and nothing under /api/dav/ reaches another upstream"
        ok=1
        for p in "/api/davx;y" "//api/dav/a;b" "/api%2fdav/..%2fvscode/" "/./api/dav/a;b"; do
            req PROPFIND "$p" -H "Authorization: Bearer $TOKEN" -H 'Depth: 0'
            [ "$STATUS" = 400 ] || { fail "a path resembling the WebDAV mount got its exemption: $p -> $STATUS"; ok=0; }
        done
        [ "$ok" = 0 ] || pass "nothing that merely resembles /api/dav/ is let through"
    fi
    before="$(hits)"
    for p in /ws/editor /ws/editor/x; do
        req GET "$p" -H "Cookie: $SESSION"
        [ "$STATUS" = 404 ] || fail "signed-in GET $p -> $STATUS"
        ws "$p" -H "Cookie: $SESSION" -H "Origin: $ORIGIN"
        [ "$STATUS" = 404 ] || fail "signed-in WebSocket to $p -> $STATUS"
        [ -z "$TOKEN" ] || { ws "$p" -H "Authorization: Bearer $TOKEN"; [ "$STATUS" = 404 ] || fail "token WebSocket to $p -> $STATUS"; }
    done
    if [ "$(hits)" = "$before" ]; then
        pass "the editor channel is not served from outside, signed in or not"
    else
        fail "a request for the editor channel reached the sandbox"
    fi

    # --- service workers ----------------------------------------------------------
    before="$(hits)"
    for p in /sw.js /workbench/sw.js /preview/3000/sw.js /terminal/sw.js /login /_gate/sw.js; do
        req GET "$p" -H "Cookie: $SESSION" -H 'Service-Worker: script'
        [ "$STATUS" = 403 ] || fail "a service worker's script from $p -> $STATUS"
        req GET "$p" -H 'Service-Worker: script'
        [ "$STATUS" = 403 ] || fail "a service worker's script from $p, signed out -> $STATUS"
    done
    if [ "$(hits)" = "$before" ]; then
        pass "no service worker's script is served outside the editor, and none reaches the sandbox"
    else
        fail "a service worker's script request reached an upstream"
    fi
    req GET /vscode/static/sw.js -H "Cookie: $SESSION" -H 'Service-Worker: script'
    { [ "$STATUS" = 200 ] && [[ "$BODY" == *'"port":8080'* ]]; } || fail "code-server's own worker -> $STATUS"
    # The upstreams answer "swa" paths with Service-Worker-Allowed: /. From
    # the sandbox's own servers it is dropped; code-server's is moved under
    # the editor's prefix, the widest scope its worker can then claim.
    for p in /workbench/swa.js /terminal/swa.js; do
        req GET "$p" -H "Cookie: $SESSION"
        [ -z "$(header Service-Worker-Allowed)" ] || fail "Service-Worker-Allowed reached the browser from $p"
    done
    req GET /vscode/swa.js -H "Cookie: $SESSION"
    [ "$(header Service-Worker-Allowed)" = /vscode/ ] \
        || fail "code-server's Service-Worker-Allowed: / arrived as '$(header Service-Worker-Allowed)', not /vscode/"
    # Any other value from the editor is dropped: under /vscode, dot segments
    # (encoded or not), backslashes and URLs would resolve back above it.
    for v in %2F%252e%252e%2F %2F.%252e%2F %2F%252E.%2F %252f %2F%5C https%3A%2F%2Fevil.example%2F %2F_static%2F; do
        req GET "/vscode/swa.js?swa=$v" -H "Cookie: $SESSION"
        [ -z "$(header Service-Worker-Allowed)" ] \
            || fail "the editor's Service-Worker-Allowed ($v) arrived as '$(header Service-Worker-Allowed)'"
    done
    pass "code-server's workers still load, and no response widens a worker's scope past /vscode/"

    # --- 4. Rate limits and lockout, keyed on the real client ----------------
    # The sandbox cannot even reach the proxy: it is on `internal`, the proxy
    # is not, so nothing inside can send a request the gate would believe.
    reach="$(docker exec "$ECHO" node /harness.mjs signins http://proxy:8080 1 "$PASSWORD")"
    if [ "$reach" = unreachable ]; then
        pass "the sandbox cannot reach the proxy"
    else
        fail "the sandbox reached the proxy: $reach"
    fi

    # From here on Caddy trusts only a stand-in proxy at a known address (the
    # production files trust every private address, and this host is one).
    if [[ "$CADDYFILE" == *standalone* ]]; then
        TRUSTED=""
    else
        start_caddy "$CADDYFILE" test-front-proxy || { fail "caddy did not restart"; continue; }
        TRUSTED="$FRONT_PROXY_IP"
    fi
    fresh_gate || fail "the gate did not come back"

    # A peer the proxy does not trust, forging every header that ever named a
    # client: its own address is what counts.
    codes=""
    for i in 1 2 3 4 5; do
        sign_in wrong-password -H "X-Forwarded-For: 203.0.113.$i" -H "CF-Connecting-IP: 203.0.113.$i" \
            -H "X-Agentbox-Client-IP: 203.0.113.$i" -H "X-Real-IP: 203.0.113.$i"
        codes="$codes $STATUS"
    done
    sign_in "$PASSWORD" -H 'X-Forwarded-For: 203.0.113.99' -H 'CF-Connecting-IP: 203.0.113.99' -H 'X-Agentbox-Client-IP: 203.0.113.99'
    if [ "$codes" = " 401 401 401 401 401" ] && [ "$STATUS" = 429 ] && [ -n "$(header Retry-After)" ]; then
        pass "an untrusted peer forging its address is limited as itself: the sixth sign-in is refused, right password and all"
    else
        fail "rate limit through the proxy: [$codes] then $STATUS $BODY"
    fi
    [[ "$BODY" == *'"error":"rate"'* ]] || fail "rate-limited answer: $BODY"

    # Another client through the proxy is its own client.
    other="$(client - "http://proxy:8080" 1 "$PASSWORD")"
    if [ "$other" = 200 ]; then
        pass "another client through the proxy is unaffected"
    else
        fail "a second client through the proxy got $other"
    fi

    if [ -n "$TRUSTED" ]; then
        # A reverse proxy Caddy trusts is believed about its clients: its
        # X-Forwarded-For names who they are, one budget each.
        a="$(client "$TRUSTED" "http://proxy:8080" 6 "$PASSWORD" "X-Forwarded-For=198.51.100.1")"
        b="$(client "$TRUSTED" "http://proxy:8080" 1 "$PASSWORD" "X-Forwarded-For=198.51.100.2")"
        if [ "$a" = "401 401 401 401 401 429" ] && [ "$b" = 200 ]; then
            pass "a trusted proxy's X-Forwarded-For is believed, one budget per client it names"
        else
            fail "trusted proxy: client A [$a], client B [$b]"
        fi
    fi

    # Straight at the gate from inside the sandbox, forging the same headers.
    direct="$(docker exec "$ECHO" node /harness.mjs signins http://gate:7900 6 "$PASSWORD" \
        "X-Forwarded-For=198.51.100.{i}" "X-Agentbox-Client-IP=198.51.100.{i}" "CF-Connecting-IP=198.51.100.{i}")"
    if [ "$direct" = "401 401 401 401 401 429" ]; then
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

if [ "$RUN_TRAEFIK" = 1 ]; then
    printf '\n== traefik mode, behind Cloudflare (a real Traefik, a stand-in Cloudflare edge)\n'
    start_gate
    # Caddy as the traefik overlay runs it, trusting Traefik and "Cloudflare".
    start_caddy "$ROOT/proxy/Caddyfile.behind-proxy" test-traefik-cloudflare || fail "caddy did not start"
    fresh_gate || fail "the gate did not come back"
    mkdir -p "$WORK/traefik"
    # The response headers the traefik overlay sets, taken from its labels, so
    # one that would override the gate's own shows up here.
    overlay_headers="$(sed -n 's/^ *- traefik\.http\.middlewares\.agentbox-headers\.headers\.\([a-z]*\)=\(.*\)$/        \1: \2/p' \
        "$ROOT/docker-compose.traefik.yml")"
    [ -n "$overlay_headers" ] || fail "no agentbox-headers labels found in docker-compose.traefik.yml"
    cat > "$WORK/traefik/dynamic.yml" <<EOF
http:
  routers:
    agentbox:
      rule: PathPrefix(\`/\`)
      entryPoints: [web]
      service: agentbox
      middlewares: [agentbox-headers]
  middlewares:
    agentbox-headers:
      headers:
$overlay_headers
  services:
    agentbox:
      loadBalancer:
        servers:
          - url: http://proxy:8080
EOF
    # Traefik as it ships: forwarded headers from its clients are not trusted.
    docker run -d --name "$TRAEFIK_C" --network "$NET_EDGE" --ip "$TRAEFIK_IP" --network-alias traefik \
        -p 127.0.0.1::80 -v "$WORK/traefik:/dyn:ro" "$TRAEFIK_IMAGE" \
        --entrypoints.web.address=:80 --providers.file.filename=/dyn/dynamic.yml --log.level=ERROR >/dev/null
    TPORT=""
    for _ in $(seq 1 100); do
        TPORT="$(docker port "$TRAEFIK_C" 80/tcp 2>/dev/null | head -n1 | sed 's/.*://')"
        [ -n "$TPORT" ] && break
        sleep 0.2
    done
    if ! wait_for "http://127.0.0.1:$TPORT/login"; then
        fail "traefik did not route to the proxy"; docker logs "$TRAEFIK_C" >&2 || true
    else
        # The sign-in page's forms need their real Origin: the gate serves it
        # with Referrer-Policy: same-origin, and the overlay must not replace it.
        rp="$(curl -s -D - -o /dev/null "http://127.0.0.1:$TPORT/login" | tr -d '\r' | grep -i '^referrer-policy:' | sed 's/^[^:]*: *//' | paste -sd, -)"
        if [ "$rp" = same-origin ]; then
            pass "through Traefik, the sign-in page keeps the gate's Referrer-Policy: same-origin"
        else
            fail "through Traefik, the sign-in page's Referrer-Policy is '$rp'"
        fi
        # A client that reaches Traefik directly, forging Cloudflare's header
        # and X-Forwarded-For anew each time: Traefik appends its real address,
        # Caddy finds it untrusted, and that is the key.
        codes=""
        for i in 1 2 3 4 5; do
            s="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TPORT/_gate/login" \
                -H "Origin: http://127.0.0.1:$TPORT" -H 'Content-Type: application/json' \
                -H "CF-Connecting-IP: 203.0.113.$i" -H "X-Forwarded-For: 203.0.113.$i" \
                --data "{\"username\":\"$USER_NAME\",\"password\":\"wrong-password\"}")"
            codes="$codes $s"
        done
        s="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$TPORT/_gate/login" \
            -H "Origin: http://127.0.0.1:$TPORT" -H 'Content-Type: application/json' \
            -H 'CF-Connecting-IP: 203.0.113.99' --data "{\"username\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}")"
        if [ "$codes" = " 401 401 401 401 401" ] && [ "$s" = 429 ]; then
            pass "straight at Traefik, a forged CF-Connecting-IP or X-Forwarded-For changes nothing"
        else
            fail "direct to Traefik: [$codes] then $s"
        fi

        # Through the Cloudflare stand-in, CF-Connecting-IP is believed: each
        # visitor it names has a budget of its own.
        a="$(client "$CF_EDGE_IP" "http://traefik:80" 6 "$PASSWORD" "CF-Connecting-IP=198.51.100.7")"
        b="$(client "$CF_EDGE_IP" "http://traefik:80" 1 "$PASSWORD" "CF-Connecting-IP=198.51.100.8")"
        if [ "$a" = "401 401 401 401 401 429" ] && [ "$b" = 200 ]; then
            pass "through Cloudflare, each visitor's CF-Connecting-IP is its own budget"
        else
            fail "through the Cloudflare stand-in: visitor A [$a], visitor B [$b]"
        fi
        if docker logs "$GATE" 2>&1 | grep -q "sign-in failed from 198.51.100.7"; then
            pass "the gate saw the visitor's address, not Cloudflare's or Traefik's"
        else
            fail "the gate did not see the visitor's address: $(docker logs "$GATE" 2>&1 | tail -3)"
        fi
    fi
fi

printf '\n'
if [ "$FAILED" -ne 0 ]; then
    echo "gate bypass check FAILED" >&2
    exit 1
fi
echo "gate bypass check passed"
