#!/usr/bin/env bash
# A clean box to photograph: the documentation's screenshots are public, so
# they are taken of this and never of a developer's machine.
#
#   e2e/tools/clean-box.sh up [image]    # prints the gate's address
#   node e2e/tools/screenshots.mjs http://127.0.0.1:27950 ../../docs/images
#   e2e/tools/clean-box.sh down
#
# Two containers from the workspace image (agentbox/workspace:latest unless
# given), laid out like the compose stack: the sandbox — hostname `agentbox`,
# user `coder`, the workspace at /workspace, its own process table and
# network, limits of its own, and a workspace and home on disks of their own
# (so System shows theirs, not the host's) — running this checkout's bridge
# and app, code-server with this checkout's agentbox-connect, and btop; and
# the gate in a container of its own in front, published on 127.0.0.1 only.
# The workspace holds fixture projects and nothing else. Build first:
# `cd web && npm run build`.
#
# screenshots.mjs checks it is pointed at a box like this one — the paths,
# the user, a process table with nothing of a desktop in it — and refuses
# anything else.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web="$(cd "$here/../../.." && pwd)"
net=agentbox-shots
box=agentbox-shots-box
gate=agentbox-shots-gate
port="${CLEAN_BOX_PORT:-27950}"
password="${CLEAN_BOX_PASSWORD:-coder-password-1}"

down() {
  docker rm -f "$box" "$gate" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}

case "${1:-}" in
  down)
    down
    exit 0
    ;;
  up) ;;
  *)
    echo "usage: clean-box.sh up [image] | down" >&2
    exit 2
    ;;
esac
image="${2:-agentbox/workspace:latest}"

for built in app/dist/index.html bridge/dist/bridge/src/main.js gate/dist/main.js vscode-ext/dist/agentbox-connect.vsix; do
  if [ ! -e "$web/$built" ]; then
    echo "missing web/$built — run \`npm run build\` in web/ first" >&2
    exit 1
  fi
done

down
docker network create "$net" >/dev/null
# The gate believes the client address the screenshots send (documentation
# addresses, 198.51.100.x) only from the network's gateway, which is where
# the published port's traffic comes from.
gateway="$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$net")"
version="$(git -C "$web" rev-parse --short HEAD 2>/dev/null || echo dev)"

# The sandbox: the image's own layout, with this checkout's builds laid over
# the ones it shipped with.
docker run -d --rm --name "$box" --hostname agentbox --network "$net" --network-alias code \
  --cpus 4 --memory 8g --pids-limit 4096 \
  --tmpfs /workspace:size=20g,uid=1000,gid=1000,mode=0755 \
  --tmpfs /home/coder:size=20g,uid=1000,gid=1000,mode=0755 \
  -e AGENTBOX_VERSION="$version" \
  -v "$web/bridge/dist:/usr/local/lib/agentbox-workbench/bridge:ro" \
  -v "$web/app/dist:/usr/local/lib/agentbox-workbench/app:ro" \
  -v "$web/node_modules:/usr/local/lib/agentbox-workbench/node_modules:ro" \
  -v "$web/vscode-ext/dist/agentbox-connect.vsix:/usr/local/share/agentbox/agentbox-connect.vsix:ro" \
  -v "$here:/opt/agentbox-shots:ro" \
  --entrypoint bash "$image" /opt/agentbox-shots/clean-box-inside.sh >/dev/null

# The gate, outside the sandbox as in the stack, seeded with `coder`.
hash="$(node --input-type=module -e "const { hashPassword } = await import('$web/gate/dist/password.js'); console.log(await hashPassword(process.argv[1], 4));" "$password")"
docker run -d --rm --name "$gate" --network "$net" --network-alias gate -p "127.0.0.1:$port:7900" \
  --tmpfs /data:uid=1000,gid=1000,mode=0700 -e GATE_DATA_DIR=/data -e GATE_ADMIN_SOCKET=/tmp/agentbox-gate.sock \
  -e AGENTBOX_USER=coder -e AGENTBOX_PASSWORD_HASH="$hash" -e GATE_TRUSTED_PROXIES="$gateway" \
  -v "$web/gate:/opt/gate:ro" -v "$web/node_modules:/opt/node_modules:ro" \
  --entrypoint node "$image" /opt/gate/dist/main.js >/dev/null

# Ready when the gate answers and the sandbox's editor and bridge are up.
for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$port/login" >/dev/null 2>&1 &&
    docker exec "$box" curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 &&
    docker exec "$box" curl -fsS http://127.0.0.1:7800/api/health >/dev/null 2>&1; then
    echo "http://127.0.0.1:$port  (coder / $password)"
    exit 0
  fi
  sleep 1
done
echo "the clean box did not come up; docker logs $box / $gate" >&2
exit 1
