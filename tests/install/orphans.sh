#!/usr/bin/env bash
# An update must not leave behind a service the new compose file dropped (the
# old lavish and previews services did): every `up -d` that install.sh and
# `agentbox update` run passes --remove-orphans. Checked in the scripts, then
# shown to do what it says on a throwaway project.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAILED=0

for f in install.sh scripts/agentbox; do
    while IFS= read -r line; do
        case "$line" in
            *--remove-orphans*) ;;
            *) echo "FAIL $f: up -d without --remove-orphans: $line"; FAILED=1 ;;
        esac
    done < <(grep -E '^[[:space:]]*docker compose .* up -d' "$ROOT/$f" || true)
done
# The update path in particular (install.sh's first run has nothing to remove).
grep -A3 'build --pull' "$ROOT/scripts/agentbox" | grep -q 'up -d --remove-orphans' \
    || { echo "FAIL agentbox update does not remove orphans"; FAILED=1; }

WORK="$(mktemp -d)"
PROJECT="abx-orphans-$$"
trap 'docker compose -p "$PROJECT" -f "$WORK/old.yml" down -t 0 >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
cat > "$WORK/old.yml" <<'EOF'
services:
  kept: { image: alpine:3, command: sleep 300 }
  dropped: { image: alpine:3, command: sleep 300 }
EOF
cat > "$WORK/new.yml" <<'EOF'
services:
  kept: { image: alpine:3, command: sleep 300 }
EOF
docker compose -p "$PROJECT" -f "$WORK/old.yml" up -d --quiet-pull >/dev/null 2>&1
docker compose -p "$PROJECT" -f "$WORK/new.yml" up -d --remove-orphans >/dev/null 2>&1
if docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Label "com.docker.compose.service"}}' | grep -qx dropped; then
    echo "FAIL a dropped service kept running"
    FAILED=1
fi

[ "$FAILED" -eq 0 ] || exit 1
echo "orphans check passed"
