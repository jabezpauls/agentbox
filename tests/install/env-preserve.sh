#!/usr/bin/env bash
# What re-running install.sh does to an existing .env.
#
# Runs the real installer in its env-only mode (AGENTBOX_INSTALL_ENV_ONLY=1:
# write .env, touch nothing else) against a scratch install directory, and
# checks that a re-run keeps every setting it was not told to change, never
# drops a key it does not manage, and never re-escapes the password hash.
#
# No Docker needed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

FAILED=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }

DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
touch "$DIR/docker-compose.yml"

# A traefik install as the real box has it, with a key added by hand.
# shellcheck disable=SC2016  # a literal Compose-escaped bcrypt hash
HASH='$$2a$$14$$abcdefghijklmnopqrstuuKO0DUaDUZ9L.Qq0OZ9nZ5tQmZ6q1pO'
seed() {
    cat > "$DIR/.env" <<ENV
AGENTBOX_DOMAIN=work.example.com
AGENTBOX_MODE=traefik
AGENTBOX_BIND=127.0.0.1:8443
AGENTBOX_EDGE_NETWORK=edge-custom
AGENTBOX_CERT_RESOLVER=cloudflare
AGENTBOX_USER=jabe
AGENTBOX_PASSWORD_HASH=$HASH
AGENTBOX_PREVIEW_DOMAIN=
AGENTBOX_PUBLIC_URL=https://work.example.com
AGENTBOX_CPUS=3
AGENTBOX_MEMORY=6g
AGENTBOX_PROXY_CPUS=0.5
AGENTBOX_PROXY_MEMORY=128m
TZ=Asia/Kolkata
ANTHROPIC_API_KEY=sk-ant-keepme
OPENAI_API_KEY=
AGENTBOX_CLIENT_IP_HEADER=X-Real-IP
ENV
}

run() { AGENTBOX_INSTALL_ENV_ONLY=1 bash "$ROOT/install.sh" --dir "$DIR" --yes "$@" >/dev/null; }
get() { grep -m1 "^$1=" "$DIR/.env" | cut -d= -f2-; }
expect() {
    # expect <key> <value> <what>
    if [ "$(get "$1")" = "$2" ]; then pass "$3"; else fail "$3 ($1='$(get "$1")', wanted '$2')"; fi
}

echo "re-run with only --isolate-host"
seed
run --isolate-host
expect AGENTBOX_MODE traefik "mode stays traefik (does not flip to standalone and grab :80/:443)"
expect AGENTBOX_DOMAIN work.example.com "domain kept"
expect AGENTBOX_EDGE_NETWORK edge-custom "edge network kept"
expect AGENTBOX_CERT_RESOLVER cloudflare "cert resolver kept"
expect AGENTBOX_USER jabe "username kept"
expect AGENTBOX_CPUS 3 "sandbox caps kept"
expect AGENTBOX_PROXY_MEMORY 128m "proxy caps kept"
expect ANTHROPIC_API_KEY sk-ant-keepme "API key kept"
expect TZ Asia/Kolkata "TZ kept"
expect AGENTBOX_CLIENT_IP_HEADER X-Real-IP "a key the installer does not manage is kept"
expect AGENTBOX_PASSWORD_HASH "$HASH" "password hash kept byte-for-byte (not re-escaped)"
expect AGENTBOX_PUBLIC_URL https://work.example.com "public URL kept"
expect AGENTBOX_PREVIEW_MODE path "a key new to this version gets its default"
if [ "$(grep -c '^AGENTBOX_MODE=' "$DIR/.env")" = 1 ]; then pass "no duplicated keys"; else fail "duplicated keys"; fi

echo "re-run twice more"
run --isolate-host
run
expect AGENTBOX_PASSWORD_HASH "$HASH" "hash still unchanged after three runs"

echo "a flag overrides just its own key"
seed
run --agents claude
expect AGENTBOX_AGENTS claude "agents changed"
expect AGENTBOX_MODE traefik "mode untouched"
expect ANTHROPIC_API_KEY sk-ant-keepme "API key untouched"

echo "an empty agent list is a choice, not a default"
seed
run --agents ''
if grep -q '^AGENTBOX_AGENTS=$' "$DIR/.env"; then pass "AGENTBOX_AGENTS= written empty"; else fail "empty agents: '$(get AGENTBOX_AGENTS)'"; fi
run
if grep -q '^AGENTBOX_AGENTS=$' "$DIR/.env"; then pass "and kept empty on the next run"; else fail "empty agents reset to '$(get AGENTBOX_AGENTS)'"; fi

echo "changing the mode"
seed
run --mode behind-proxy --bind 127.0.0.1:9000
expect AGENTBOX_MODE behind-proxy "mode changed"
expect AGENTBOX_BIND 127.0.0.1:9000 "bind changed"
expect AGENTBOX_EDGE_NETWORK edge-custom "traefik settings left in place for a later switch back"

echo "a new domain moves the public URL with it"
seed
run --domain new.example.com
expect AGENTBOX_PUBLIC_URL https://new.example.com "public URL follows --domain"

echo "a localhost install records no public URL"
cat > "$DIR/.env" <<ENV
AGENTBOX_PASSWORD_HASH=$HASH
ENV
run --mode behind-proxy
expect AGENTBOX_DOMAIN localhost "domain defaults to localhost"
expect AGENTBOX_PUBLIC_URL "" "no https://localhost written as a public URL"

echo "a localhost public URL an older installer wrote is dropped, not kept"
for stale in https://localhost http://localhost:8443 https://127.0.0.1/ http://127.0.0.1:8443; do
    cat > "$DIR/.env" <<ENV
AGENTBOX_DOMAIN=localhost
AGENTBOX_MODE=behind-proxy
AGENTBOX_PASSWORD_HASH=$HASH
AGENTBOX_PUBLIC_URL=$stale
ENV
    run
    expect AGENTBOX_PUBLIC_URL "" "$stale is not kept as the public URL"
done
seed
run
expect AGENTBOX_PUBLIC_URL https://work.example.com "a real public URL is still kept"

echo "the removed per-port preview hostnames"
seed
if AGENTBOX_INSTALL_ENV_ONLY=1 bash "$ROOT/install.sh" --dir "$DIR" --yes --preview-domain p.example.com 2>"$DIR/err" >/dev/null; then
    pass "--preview-domain is still accepted, so old commands keep working"
else
    fail "--preview-domain now fails the install"
fi
if grep -q "no longer does anything" "$DIR/err"; then pass "and says it is ignored"; else fail "no warning for --preview-domain"; fi
expect AGENTBOX_PREVIEW_DOMAIN "" "an existing key is left as it was, never set"

echo "bad input"
seed
if AGENTBOX_INSTALL_ENV_ONLY=1 bash "$ROOT/install.sh" --dir "$DIR" --yes --user $'jabe\nAGENTBOX_MODE=standalone' >/dev/null 2>&1; then
    fail "a newline in a value was accepted"
else
    pass "a newline in a value is refused"
fi
expect AGENTBOX_MODE traefik ".env untouched by the refused run"
if AGENTBOX_INSTALL_ENV_ONLY=1 bash "$ROOT/install.sh" --dir "$DIR" --yes --agents 'claude;rm' >/dev/null 2>&1; then
    fail "a malformed agent list was accepted"
else
    pass "a malformed agent list is refused"
fi

echo "agentbox update validates before touching anything"
seed
mkdir -p "$DIR/scripts"
cp "$ROOT/scripts/agentbox" "$ROOT/scripts/isolate-host.sh" "$DIR/scripts/"
before="$(cat "$DIR/.env")"
for args in "--mode bogus" "--preview public" "--agents claude;x" "--agents claude --mode bogus"; do
    # shellcheck disable=SC2086  # word-split on purpose: each entry is a flag and value
    if (cd / && "$DIR/scripts/agentbox" update $args) >/dev/null 2>&1; then
        fail "update accepted $args"
    else
        pass "update refuses $args"
    fi
done
if (cd / && "$DIR/scripts/agentbox" update --preview-domain $'a.example.com\nAGENTBOX_MODE=standalone') >/dev/null 2>&1; then
    fail "update accepted a newline in a value"
else
    pass "update refuses a newline in a value"
fi
if [ "$(cat "$DIR/.env")" = "$before" ]; then pass ".env untouched by refused updates"; else fail ".env changed by a refused update"; fi

[ "$FAILED" -eq 0 ] || { echo "env-preserve check FAILED" >&2; exit 1; }
echo "env-preserve check passed"
