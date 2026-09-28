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

# Codex reads standing instructions from ~/.codex/AGENTS.md, on the home
# volume, which the person may edit too. agentbox's part is a marked block,
# replaced on every start so an image update ships new instructions, and
# everything outside the markers is kept as it was. (Claude Code reads the same
# text from /etc/claude-code/CLAUDE.md, baked into the image.)
agents=/usr/local/share/agentbox/agents.md
if [ -f "$agents" ]; then
    mkdir -p /home/coder/.codex
    target=/home/coder/.codex/AGENTS.md
    begin='<!-- agentbox:begin (managed by agentbox; edits inside are replaced on restart) -->'
    end='<!-- agentbox:end -->'
    # Whatever was there, less any earlier copy of the block and the blank
    # lines that led into it.
    theirs=""
    if [ -f "$target" ]; then
        theirs="$(awk -v e="$end" '
            index($0, "<!-- agentbox:begin") == 1 { skip = 1; next }
            skip { if ($0 == e) skip = 0; next }
            { print }
        ' "$target" | sed '/./,$!d')"
    fi
    if tmp="$(mktemp "$target.XXXXXX")"; then
        if {
            printf '%s\n' "$begin"
            cat "$agents"
            printf '%s\n' "$end"
            [ -z "$theirs" ] || printf '\n%s\n' "$theirs"
        } >"$tmp"; then
            mv "$tmp" "$target"
        else
            rm -f "$tmp"
        fi
    fi
fi

# The editor extension that joins code-server to the app lives on the home
# volume like any extension, so an image update would never reach a volume
# that already has an older copy. Reinstall it when the image's build stamp
# differs from the one recorded at the last install — only in the editor's own
# container, since every sandbox service shares this volume.
vsix=/usr/local/share/agentbox/agentbox-connect.vsix
marker=/home/coder/.local/share/code-server/agentbox-connect.installed
if [ "${1:-}" = code-server ] && [ -f "$vsix" ]; then
    want="$(cat /usr/local/share/agentbox/agentbox-connect.version 2>/dev/null || true)"
    have="$(cat "$marker" 2>/dev/null || true)"
    if [ -n "$want" ] && [ "$want" != "$have" ]; then
        if code-server --install-extension "$vsix" --force >/dev/null 2>&1; then
            mkdir -p "$(dirname "$marker")" && printf '%s\n' "$want" >"$marker"
        else
            echo "note: could not install the agentbox connect extension" >&2
        fi
    fi
fi

# Git works out of the box inside the sandbox rather than erroring on ownership.
git config --global --get safe.directory >/dev/null 2>&1 || \
    git config --global --add safe.directory '*'

exec "$@"
