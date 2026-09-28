#!/usr/bin/env bash
# `agentbox restart` must not strand the services that share the editor's
# network namespace. `docker compose restart` brings each back on its own, and
# the terminals and the Workbench then exit, unable to join the namespace of
# the `code` container they were started with. So a restart of everything, or
# of `code`, is a stop and an `up -d`; only other services restart alone.
#
# Runs the real script against a stand-in `docker` that records its calls.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAILED=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/box/scripts" "$WORK/bin"
cp "$ROOT/scripts/agentbox" "$WORK/box/scripts/"
printf 'AGENTBOX_MODE=behind-proxy\n' > "$WORK/box/.env"
cat > "$WORK/bin/docker" <<EOF
#!/bin/sh
echo "\$*" | sed 's/^compose -f docker-compose.yml -f docker-compose.behind-proxy.yml //' >> "$WORK/calls"
EOF
chmod +x "$WORK/bin/docker"

calls() { rm -f "$WORK/calls"; PATH="$WORK/bin:$PATH" "$WORK/box/scripts/agentbox" restart "$@"; tr '\n' ';' < "$WORK/calls"; }

for args in "" "code" "workbench code"; do
    got="$(calls $args)"
    if [ "$got" = "stop;up -d;" ]; then pass "restart ${args:-(everything)} stops and starts in order"; else fail "restart ${args:-(everything)} ran: $got"; fi
done
got="$(calls workbench)"
if [ "$got" = "restart workbench;" ]; then pass "restart workbench restarts it alone"; else fail "restart workbench ran: $got"; fi

[ "$FAILED" -eq 0 ] || { echo "restart check FAILED" >&2; exit 1; }
echo "restart check passed"
