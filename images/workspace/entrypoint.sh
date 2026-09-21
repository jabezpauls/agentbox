#!/usr/bin/env bash
# Prepare the writable volumes on first run, then hand off to the service
# command. Runs as UID 1000; nothing here needs or gains privilege.
set -euo pipefail

mkdir -p /workspace /home/coder/.config /home/coder/.npm-global

# Seed a starting point so a brand-new workspace is not an empty void.
if [ ! -e /workspace/WELCOME.md ] && [ -e /home/coder/welcome.md ]; then
    cp /home/coder/welcome.md /workspace/WELCOME.md || true
fi

# Agent skills live under the home volume, which shadows whatever the image put
# there, so they are staged outside it and copied in on every start. Copying
# unconditionally means an image update ships an updated skill rather than
# leaving the first-run copy in place forever.
if [ -d /usr/local/share/agentbox/skills ]; then
    mkdir -p /home/coder/.claude/skills
    cp -r /usr/local/share/agentbox/skills/. /home/coder/.claude/skills/ || true
fi

# Git works out of the box inside the sandbox rather than erroring on ownership.
git config --global --get safe.directory >/dev/null 2>&1 || \
    git config --global --add safe.directory '*'

exec "$@"
