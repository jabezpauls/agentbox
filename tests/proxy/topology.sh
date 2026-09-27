#!/usr/bin/env bash
# Who can reach whom, as each compose mode actually wires it.
#
# The gate believes a client address only from the proxy, so nothing in the
# sandbox may be able to send through the proxy: the proxy must share a network
# with the gate and nothing else of ours, and no sandbox service may join the
# gate-only network. Also: the traefik overlay publishes no port, and the other
# two publish exactly the proxy's. The checks are in topology.py.
#
# Needs Docker Compose and python3; builds nothing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

FAILED=0
ENV="$(mktemp)"
trap 'rm -f "$ENV"' EXIT
cp .env.example "$ENV"
# A literal, Compose-escaped placeholder hash: the '$$' are meant.
# shellcheck disable=SC2016
sed -i 's|^AGENTBOX_PASSWORD_HASH=.*|AGENTBOX_PASSWORD_HASH=$$2a$$14$$placeholderplaceholderplaceholderplaceholder|' "$ENV"

for mode in standalone behind-proxy traefik; do
    printf '== %s\n' "$mode"
    if ! docker compose --env-file "$ENV" -f docker-compose.yml -f "docker-compose.$mode.yml" config --format json \
        | python3 "$ROOT/tests/proxy/topology.py" "$mode" | sed 's/^/  /'; then
        FAILED=1
    fi
done

[ "$FAILED" -eq 0 ] || { echo "topology check FAILED" >&2; exit 1; }
echo "topology check passed"
