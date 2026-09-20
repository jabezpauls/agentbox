#!/usr/bin/env bash
# Prepare the writable volumes on first run, then hand off to the service
# command. Runs as UID 1000; nothing here needs or gains privilege.
set -euo pipefail

mkdir -p /workspace /home/coder/.config /home/coder/.npm-global

# Seed a starting point so a brand-new workspace is not an empty void.
if [ ! -e /workspace/WELCOME.md ] && [ -e /home/coder/welcome.md ]; then
    cp /home/coder/welcome.md /workspace/WELCOME.md || true
fi

# Git works out of the box inside the sandbox rather than erroring on ownership.
git config --global --get safe.directory >/dev/null 2>&1 || \
    git config --global --add safe.directory '*'

exec "$@"
