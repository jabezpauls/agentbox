#!/usr/bin/env bash
# Who can reach whom, as each compose mode actually wires it.
#
# The gate believes a client address only from the proxy, so nothing in the
# sandbox may be able to send through the proxy: the proxy must share a network
# with the gate and nothing else of ours, and no sandbox service may join the
# gate-only network. Also: the traefik overlays publish no port, and the other
# two publish exactly the proxy's; the passthrough overlay passes TLS through
# by SNI with a PROXY header, and trusts no forwarding header. With Docker
# inside the sandbox, the engine is unprivileged, publishes nothing, shares the
# sandbox's network alone, and is reached by one in-memory socket only UID 1000
# can open; no container gets the host's Docker socket or a host path. The
# checks are in topology.py.
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

# Each mode on its own, and with Docker inside the sandbox
# (docker-compose.docker.yml), which must leave all of the above as it was.
for mode in standalone behind-proxy traefik traefik-passthrough; do
    for docker in "" docker; do
        printf '== %s%s\n' "$mode" "${docker:+ + docker}"
        files=(-f docker-compose.yml -f "docker-compose.$mode.yml")
        [ -n "$docker" ] && files+=(-f docker-compose.docker.yml)
        # $docker unquoted on purpose: empty, it is no argument at all.
        # shellcheck disable=SC2086
        if ! docker compose --env-file "$ENV" "${files[@]}" config --format json \
            | python3 "$ROOT/tests/proxy/topology.py" "$mode" $docker | sed 's/^/  /'; then
            FAILED=1
        fi
    done
done

[ "$FAILED" -eq 0 ] || { echo "topology check FAILED" >&2; exit 1; }
echo "topology check passed"
