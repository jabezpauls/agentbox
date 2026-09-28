#!/usr/bin/env bash
# Run the fidelity suite inside the official Playwright image, for a host
# without Firefox's or WebKit's system libraries (any distribution Playwright
# does not support). The image's version is the repository's @playwright/test,
# so its browsers are the ones the suite expects.
#
#   web/app/fidelity/in-docker.sh                          # all three engines
#   web/app/fidelity/in-docker.sh --project webkit         # any playwright args
#
# Needs Docker, the web build (cd web && npm run build), the fixture's
# dependencies (npm run fidelity:deps -w app) and herdr: on PATH, or named by
# HERDR_BIN. The checkout is mounted at its own path, as the invoking user.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
VERSION="$(node -p "require('$ROOT/web/node_modules/@playwright/test/package.json').version")"
IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v$VERSION-noble}"
HERDR_BIN="${HERDR_BIN:-$(command -v herdr || true)}"
[ -x "$HERDR_BIN" ] || { echo "herdr not found: put it on PATH or set HERDR_BIN (scripts/install-herdr.sh fetches it)" >&2; exit 1; }

exec docker run --rm --init --ipc=host \
    --user "$(id -u):$(id -g)" -e HOME=/tmp/home -e CI="${CI:-}" \
    -v "$ROOT:$ROOT" -v "$HERDR_BIN:/usr/local/bin/herdr:ro" \
    -w "$ROOT/web/app" "$IMAGE" \
    npx playwright test -c playwright.fidelity.config.ts "$@"
