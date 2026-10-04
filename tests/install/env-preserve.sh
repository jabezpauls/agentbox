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
AGENTBOX_USER=alice
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
MY_OWN_SETTING=keep me
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
expect AGENTBOX_USER alice "username kept"
expect AGENTBOX_CPUS 3 "sandbox caps kept"
expect AGENTBOX_PROXY_MEMORY 128m "proxy caps kept"
expect ANTHROPIC_API_KEY sk-ant-keepme "API key kept"
expect TZ Asia/Kolkata "TZ kept"
expect MY_OWN_SETTING "keep me" "a key the installer does not manage is kept"
expect AGENTBOX_PASSWORD_HASH "$HASH" "password hash kept byte-for-byte (not re-escaped)"
expect AGENTBOX_PUBLIC_URL https://work.example.com "public URL kept"
expect AGENTBOX_SHARING on "a key new to this version gets its default"
if [ "$(grep -c '^AGENTBOX_MODE=' "$DIR/.env")" = 1 ]; then pass "no duplicated keys"; else fail "duplicated keys"; fi

echo "re-run twice more"
run --isolate-host
run
expect AGENTBOX_PASSWORD_HASH "$HASH" "hash still unchanged after three runs"
expect AGENTBOX_VERSION dev "outside a checkout the version is dev"
if [ "$(grep -c '^AGENTBOX_VERSION=' "$DIR/.env")" = 1 ]; then pass "the version is written once"; else fail "AGENTBOX_VERSION duplicated"; fi

echo "the version comes from the install's own checkout"
seed
git -C "$DIR" -c init.defaultBranch=main init -q
git -C "$DIR" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m one
git -C "$DIR" tag v9.9.9
echo "AGENTBOX_VERSION=v0.0.1" >> "$DIR/.env"
run
expect AGENTBOX_VERSION v9.9.9 "install writes the checkout's tag, replacing the old one"
git -C "$DIR" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m two
run
case "$(get AGENTBOX_VERSION)" in
    v9.9.9-1-g*) pass "a commit past the tag says so" ;;
    *) fail "a commit past the tag: '$(get AGENTBOX_VERSION)'" ;;
esac
if [ "$(grep -c '^AGENTBOX_VERSION=' "$DIR/.env")" = 1 ]; then pass "and is still written once"; else fail "AGENTBOX_VERSION duplicated"; fi
rm -rf "$DIR/.git"

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

echo "sharing, and its older name"
seed
run --sharing off
expect AGENTBOX_SHARING off "--sharing off is written"
run
expect AGENTBOX_SHARING off "and kept on the next run"
run --preview path
expect AGENTBOX_SHARING on "--preview path is the old spelling of --sharing on"
run --preview off
expect AGENTBOX_SHARING off "--preview off is the old spelling of --sharing off"
seed
echo "AGENTBOX_PREVIEW_MODE=off" >> "$DIR/.env"
run
expect AGENTBOX_SHARING off "an older .env's AGENTBOX_PREVIEW_MODE=off carries over as sharing off"
if grep -q '^AGENTBOX_PREVIEW_MODE=' "$DIR/.env"; then fail "AGENTBOX_PREVIEW_MODE is still in .env"; else pass "and the old key is gone"; fi
seed
echo "AGENTBOX_PREVIEW_MODE=path" >> "$DIR/.env"
run --sharing off
expect AGENTBOX_SHARING off "a flag beats the older key"
if AGENTBOX_INSTALL_ENV_ONLY=1 bash "$ROOT/install.sh" --dir "$DIR" --yes --sharing maybe >/dev/null 2>&1; then
    fail "--sharing maybe was accepted"
else
    pass "--sharing takes on or off only"
fi

echo "the removed per-port preview hostnames"
seed
if AGENTBOX_INSTALL_ENV_ONLY=1 bash "$ROOT/install.sh" --dir "$DIR" --yes --preview-domain p.example.com 2>"$DIR/err" >/dev/null; then
    pass "--preview-domain is still accepted, so old commands keep working"
else
    fail "--preview-domain now fails the install"
fi
if grep -q "no longer does anything" "$DIR/err"; then pass "and says it is ignored"; else fail "no warning for --preview-domain"; fi
expect AGENTBOX_PREVIEW_DOMAIN "" "an existing key is left as it was, never set"

echo "behind Cloudflare: an explicit choice, the old header's meaning, or the mode's default"
seed   # traefik, with AGENTBOX_CLIENT_IP_HEADER=X-Real-IP added by hand
run
expect AGENTBOX_CLOUDFLARE off "an older .env naming another header means not behind Cloudflare"
expect AGENTBOX_REAL_IP_HEADER X-Real-IP "and that header moves to AGENTBOX_REAL_IP_HEADER, which Caddy reads"
sed -i 's/^AGENTBOX_CLIENT_IP_HEADER=.*/AGENTBOX_CLIENT_IP_HEADER=CF-Connecting-IP/; /^AGENTBOX_CLOUDFLARE=/d' "$DIR/.env"
run
expect AGENTBOX_CLOUDFLARE on "an older .env naming CF-Connecting-IP means behind Cloudflare"
seed
sed -i '/^AGENTBOX_CLIENT_IP_HEADER=/d' "$DIR/.env"
run
expect AGENTBOX_CLOUDFLARE on "a traefik install that never said defaults to Cloudflare, as it always assumed"
run --mode behind-proxy
expect AGENTBOX_CLOUDFLARE on "a recorded choice is kept when the mode changes"
cat > "$DIR/.env" <<ENV
AGENTBOX_PASSWORD_HASH=$HASH
ENV
run --mode behind-proxy
expect AGENTBOX_CLOUDFLARE off "a fresh behind-proxy install defaults to not behind Cloudflare"
run --cloudflare on
expect AGENTBOX_CLOUDFLARE on "--cloudflare on is written"
run
expect AGENTBOX_CLOUDFLARE on "and kept on the next run"

echo "the older AGENTBOX_CLIENT_IP_HEADER is removed, whatever it held"
# Caddy never reads it; left in place, it would only mislead. CF-Connecting-IP
# and X-Forwarded-For are headers Caddy reads anyway (named twice, they would
# stop it starting), so only another header moves over.
for case in "CF-Connecting-IP:" "cf-connecting-ip:" "X-Forwarded-For:" "x-forwarded-for:" ":" "X-Real-IP:X-Real-IP" "True-Client-IP:True-Client-IP"; do
    old="${case%%:*}"; moved="${case#*:}"
    for cloudflare in "" on; do
        # With AGENTBOX_CLOUDFLARE already recorded too: an .env an earlier
        # build of this installer wrote kept the old key alongside it.
        seed
        sed -i "s/^AGENTBOX_CLIENT_IP_HEADER=.*/AGENTBOX_CLIENT_IP_HEADER=$old/" "$DIR/.env"
        [ -n "$cloudflare" ] && echo "AGENTBOX_CLOUDFLARE=$cloudflare" >> "$DIR/.env"
        run
        what="AGENTBOX_CLIENT_IP_HEADER=${old:-(empty)}${cloudflare:+ with AGENTBOX_CLOUDFLARE=$cloudflare}"
        if grep -q '^AGENTBOX_CLIENT_IP_HEADER=' "$DIR/.env"; then fail "install: $what is still in .env"; else pass "install: $what is removed"; fi
        expect AGENTBOX_REAL_IP_HEADER "$moved" "install: $what leaves AGENTBOX_REAL_IP_HEADER='$moved'"
        [ -n "$cloudflare" ] && expect AGENTBOX_CLOUDFLARE "$cloudflare" "install: and the recorded Cloudflare choice stands"
    done
done
seed
echo "AGENTBOX_REAL_IP_HEADER=X-Client-IP" >> "$DIR/.env"
run
expect AGENTBOX_REAL_IP_HEADER X-Client-IP "a header already set is not replaced by the old key's"

echo "a client-IP header Caddy already reads is refused"
cat > "$DIR/.env" <<ENV
AGENTBOX_MODE=behind-proxy
AGENTBOX_PASSWORD_HASH=$HASH
ENV
before_hdr="$(cat "$DIR/.env")"
for bad in CF-Connecting-IP cf-connecting-ip X-Forwarded-For X-FORWARDED-FOR X-Agentbox-Client-IP "X-Real-IP X-Forwarded-For" "X}" "a:b"; do
    if AGENTBOX_INSTALL_ENV_ONLY=1 bash "$ROOT/install.sh" --dir "$DIR" --yes --real-ip-header "$bad" >/dev/null 2>"$DIR/err"; then
        fail "install accepted --real-ip-header '$bad'"
    else
        pass "install refuses --real-ip-header '$bad'"
    fi
done
AGENTBOX_INSTALL_ENV_ONLY=1 bash "$ROOT/install.sh" --dir "$DIR" --yes --real-ip-header CF-Connecting-IP >/dev/null 2>"$DIR/err" || true
if grep -q -- "--cloudflare on" "$DIR/err"; then pass "and CF-Connecting-IP is pointed at --cloudflare on"; else fail "no pointer to --cloudflare on: $(cat "$DIR/err")"; fi
if [ "$(cat "$DIR/.env")" = "$before_hdr" ]; then pass ".env untouched by a refused header"; else fail ".env changed by a refused header"; fi
echo "AGENTBOX_REAL_IP_HEADER=X-Forwarded-For" >> "$DIR/.env"
if AGENTBOX_INSTALL_ENV_ONLY=1 bash "$ROOT/install.sh" --dir "$DIR" --yes >/dev/null 2>&1; then
    fail "install accepted AGENTBOX_REAL_IP_HEADER=X-Forwarded-For set by hand in .env"
else
    pass "install refuses AGENTBOX_REAL_IP_HEADER=X-Forwarded-For set by hand in .env"
fi
sed -i '/^AGENTBOX_REAL_IP_HEADER=/d' "$DIR/.env"
run --real-ip-header X-Real-IP
expect AGENTBOX_REAL_IP_HEADER X-Real-IP "--real-ip-header X-Real-IP is written"
run
expect AGENTBOX_REAL_IP_HEADER X-Real-IP "and kept on the next run"
run --real-ip-header ''
expect AGENTBOX_REAL_IP_HEADER "" "and cleared with --real-ip-header ''"

echo "bad input"
seed
if AGENTBOX_INSTALL_ENV_ONLY=1 bash "$ROOT/install.sh" --dir "$DIR" --yes --cloudflare maybe >/dev/null 2>&1; then
    fail "--cloudflare maybe was accepted"
else
    pass "--cloudflare takes on or off only"
fi
before_pw="$(cat "$DIR/.env")"
for bad in short "$(printf 'x%.0s' $(seq 1 73))"; do
    if AGENTBOX_INSTALL_ENV_ONLY=1 bash "$ROOT/install.sh" --dir "$DIR" --yes --password "$bad" >/dev/null 2>&1; then
        fail "--password of ${#bad} characters was accepted"
    else
        pass "--password of ${#bad} characters is refused before anything happens"
    fi
done
if [ "$(cat "$DIR/.env")" = "$before_pw" ]; then pass ".env untouched by a refused password"; else fail ".env changed by a refused password"; fi
seed
if AGENTBOX_INSTALL_ENV_ONLY=1 bash "$ROOT/install.sh" --dir "$DIR" --yes --user $'alice\nAGENTBOX_MODE=standalone' >/dev/null 2>&1; then
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
for args in "--mode bogus" "--preview public" "--cloudflare maybe" "--agents claude;x" "--agents claude --mode bogus" \
    "--real-ip-header CF-Connecting-IP" "--real-ip-header x-forwarded-for" "--real-ip-header X-Agentbox-Client-IP" "--real-ip-header X}"; do
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

echo "agentbox update carries an older .env's Cloudflare choice over"
# It fails at `git pull` (not a checkout), after the settings are written.
for header in "CF-Connecting-IP:on" "X-Real-IP:off" ":off"; do
    seed
    sed -i "s/^AGENTBOX_CLIENT_IP_HEADER=.*/AGENTBOX_CLIENT_IP_HEADER=${header%%:*}/" "$DIR/.env"
    (cd / && "$DIR/scripts/agentbox" update) >/dev/null 2>&1 || true
    expect AGENTBOX_CLOUDFLARE "${header#*:}" "AGENTBOX_CLIENT_IP_HEADER=${header%%:*} becomes AGENTBOX_CLOUDFLARE=${header#*:}"
done
seed
sed -i '/^AGENTBOX_CLIENT_IP_HEADER=/d' "$DIR/.env"
(cd / && "$DIR/scripts/agentbox" update) >/dev/null 2>&1 || true
expect AGENTBOX_CLOUDFLARE on "a traefik .env that never said becomes on"

echo "agentbox update removes the older AGENTBOX_CLIENT_IP_HEADER"
for case in "CF-Connecting-IP:" "X-Forwarded-For:" ":" "X-Real-IP:X-Real-IP"; do
    old="${case%%:*}"; moved="${case#*:}"
    for cloudflare in "" on; do
        seed
        sed -i "s/^AGENTBOX_CLIENT_IP_HEADER=.*/AGENTBOX_CLIENT_IP_HEADER=$old/" "$DIR/.env"
        [ -n "$cloudflare" ] && echo "AGENTBOX_CLOUDFLARE=$cloudflare" >> "$DIR/.env"
        (cd / && "$DIR/scripts/agentbox" update) >/dev/null 2>&1 || true
        what="AGENTBOX_CLIENT_IP_HEADER=${old:-(empty)}${cloudflare:+ with AGENTBOX_CLOUDFLARE=$cloudflare}"
        if grep -q '^AGENTBOX_CLIENT_IP_HEADER=' "$DIR/.env"; then fail "update: $what is still in .env"; else pass "update: $what is removed"; fi
        expect AGENTBOX_REAL_IP_HEADER "$moved" "update: $what leaves AGENTBOX_REAL_IP_HEADER='$moved'"
    done
done
echo "agentbox update refuses a client-IP header Caddy already reads, before restarting anything"
for bad in CF-Connecting-IP X-Forwarded-For; do
    seed
    echo "AGENTBOX_REAL_IP_HEADER=$bad" >> "$DIR/.env"
    (cd / && "$DIR/scripts/agentbox" update) >/dev/null 2>"$DIR/err" || true
    if grep -q "AGENTBOX_REAL_IP_HEADER=$bad" "$DIR/err" && ! grep -qi "git\|fatal" "$DIR/err"; then
        pass "update refuses AGENTBOX_REAL_IP_HEADER=$bad set by hand, before git pull"
    else
        fail "update did not refuse AGENTBOX_REAL_IP_HEADER=$bad: $(cat "$DIR/err")"
    fi
done
if grep -q -- "--cloudflare on" "$DIR/err"; then pass "and points at --cloudflare on"; else fail "no pointer to --cloudflare on: $(cat "$DIR/err")"; fi
seed
(cd / && "$DIR/scripts/agentbox" update --real-ip-header X-Real-IP) >/dev/null 2>&1 || true
expect AGENTBOX_REAL_IP_HEADER X-Real-IP "update --real-ip-header X-Real-IP is written"

echo "agentbox update records the version it updates to"
# A checkout with an upstream to pull from, and a docker that does nothing.
UP="$(mktemp -d)"
trap 'rm -rf "$DIR" "$UP"' EXIT
mkdir -p "$UP/src/scripts" "$UP/bin"
cp "$ROOT/scripts/agentbox" "$ROOT/scripts/isolate-host.sh" "$UP/src/scripts/"
touch "$UP/src/docker-compose.yml"
# A checkout builds its images, so it has their sources.
mkdir -p "$UP/src/images/workspace" "$UP/src/web"
touch "$UP/src/images/workspace/Dockerfile" "$UP/src/web/package.json"
printf '.env\n' > "$UP/src/.gitignore"
git -C "$UP/src" -c init.defaultBranch=main init -q
git -C "$UP/src" add -A
git -C "$UP/src" -c user.name=t -c user.email=t@example.com commit -q -m one
git -C "$UP/src" tag v9.9.10
git clone -q "$UP/src" "$UP/box"
printf '#!/bin/sh\nexit 0\n' > "$UP/bin/docker"
chmod +x "$UP/bin/docker"
seed
cp "$DIR/.env" "$UP/box/.env"
echo "AGENTBOX_VERSION=v0.0.1" >> "$UP/box/.env"
upget() { grep -m1 "^$1=" "$UP/box/.env" | cut -d= -f2-; }
if (cd / && PATH="$UP/bin:$PATH" "$UP/box/scripts/agentbox" update) >/dev/null 2>"$UP/err"; then
    if [ "$(upget AGENTBOX_VERSION)" = v9.9.10 ]; then pass "update writes the checkout's tag"; else fail "update wrote AGENTBOX_VERSION='$(upget AGENTBOX_VERSION)'"; fi
else
    fail "update failed: $(cat "$UP/err")"
fi
echo "# changed" >> "$UP/box/docker-compose.yml"
(cd / && PATH="$UP/bin:$PATH" "$UP/box/scripts/agentbox" update) >/dev/null 2>&1 || true
if [ "$(upget AGENTBOX_VERSION)" = v9.9.10-dirty ]; then pass "and says when the checkout was changed by hand"; else fail "dirty checkout: '$(upget AGENTBOX_VERSION)'"; fi
if [ "$(grep -c '^AGENTBOX_VERSION=' "$UP/box/.env")" = 1 ]; then pass "and writes it once"; else fail "AGENTBOX_VERSION duplicated by update"; fi
if [ "$(upget ANTHROPIC_API_KEY)" = sk-ant-keepme ]; then pass "leaving the rest of .env alone"; else fail "update lost a key"; fi

echo "behind-proxy listens on loopback unless told otherwise in so many words"
fresh() { rm -f "$DIR/.env"; AGENTBOX_INSTALL_ENV_ONLY=1 bash "$ROOT/install.sh" --dir "$DIR" --yes --password abcdefgh1 --mode behind-proxy "$@" >/dev/null 2>"$DIR/err"; }
for b in 127.0.0.1:8443 127.0.0.2:9000 localhost:8443 '[::1]:8443'; do
    if fresh --bind "$b"; then pass "--bind $b is loopback"; else fail "--bind $b refused: $(cat "$DIR/err")"; fi
done
for b in 0.0.0.0:8443 10.0.0.5:8443 8443 '[::]:8443' 192.168.1.2:80; do
    if fresh --bind "$b"; then fail "--bind $b accepted without --bind-public"; else pass "--bind $b refused without --bind-public"; fi
done
if fresh --bind 10.0.0.5:8443 --bind-public && grep -q 'warning' "$DIR/err"; then
    pass "--bind-public allows it, with a warning"
    expect AGENTBOX_BIND_PUBLIC on "and .env remembers it"
    AGENTBOX_INSTALL_ENV_ONLY=1 bash "$ROOT/install.sh" --dir "$DIR" --yes >/dev/null 2>&1 \
        && pass "so a re-run keeps working" || fail "a re-run of a --bind-public install was refused"
else
    fail "--bind-public: $(cat "$DIR/err")"
fi

echo "--tls: who terminates TLS in traefik mode"
seed
run --isolate-host
expect AGENTBOX_TLS edge "an install that never said is edge, as before"
seed
echo "AGENTBOX_CLOUDFLARE=on" >> "$DIR/.env"
run --tls passthrough 2>/dev/null
expect AGENTBOX_TLS passthrough "--tls passthrough is written"
expect AGENTBOX_CLOUDFLARE off "and Cloudflare trust carried over from edge mode is turned off"
expect AGENTBOX_REAL_IP_HEADER "" "and a carried-over real-IP header is cleared"
expect AGENTBOX_CERT_RESOLVER cloudflare "and the edge settings are kept for a way back"
run --isolate-host
expect AGENTBOX_TLS passthrough "a re-run keeps passthrough"
for args in "--tls passthrough --cloudflare on" "--tls passthrough --real-ip-header X-Real-IP" \
    "--tls passthrough --mode standalone --domain x.example.com" "--tls both"; do
    seed
    # shellcheck disable=SC2086  # each is several words
    if AGENTBOX_INSTALL_ENV_ONLY=1 bash "$ROOT/install.sh" --dir "$DIR" --yes $args >/dev/null 2>&1; then
        fail "$args was accepted"
    else
        pass "$args is refused"
    fi
done
seed
echo "AGENTBOX_CLOUDFLARE=on" >> "$DIR/.env"
(cd / && "$DIR/scripts/agentbox" update --tls passthrough) >/dev/null 2>&1 || true
expect AGENTBOX_TLS passthrough "update --tls passthrough is written"
expect AGENTBOX_CLOUDFLARE off "and turns Cloudflare trust off"

[ "$FAILED" -eq 0 ] || { echo "env-preserve check FAILED" >&2; exit 1; }
echo "env-preserve check passed"
