#!/bin/sh
# Install the agentbox CLI from your box, and sign it in:
#
#   curl -fsSL https://<your box>/cli/install | sh
#
# The box serves this script and the CLI it installs (/cli/agentbox.mjs), so
# the CLI is always the build that matches the box. It goes to
# ~/.local/share/agentbox/agentbox.mjs, with `agentbox` in ~/.local/bin linking
# to it: Node reads an ES module by its .mjs name (a bare name works only on
# the newest releases), and the link keeps that name. Options go after
# `sh -s --`:
#
#   --dir <path>   put the `agentbox` link there instead of ~/.local/bin
#                  ($AGENTBOX_INSTALL_DIR)
#   --no-login     install only; sign in later with `agentbox login`
#
# Needs Node.js 20 or newer. The whole script is one function called on the
# last line, so a download cut short runs nothing.
set -eu

# Filled in by the box that served this script.
BOX='@@AGENTBOX_URL@@'

say() { printf '%s\n' "$*"; }
die() {
    printf 'agentbox install: %s\n' "$*" >&2
    exit 1
}

fetch() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL -o "$2" "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" "$1"
    else
        # Node is needed anyway, and can download on its own.
        node -e '
            const [url, file] = process.argv.slice(1);
            fetch(url)
              .then(async (r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                require("fs").writeFileSync(file, Buffer.from(await r.arrayBuffer()));
              })
              .catch((e) => { console.error(e.message); process.exit(1); });
        ' "$1" "$2"
    fi
}

main() {
    dir="${AGENTBOX_INSTALL_DIR:-$HOME/.local/bin}"
    login=yes
    while [ $# -gt 0 ]; do
        case "$1" in
            --dir)
                [ $# -ge 2 ] || die "--dir needs a path"
                dir="$2"
                shift 2
                ;;
            --no-login)
                login=no
                shift
                ;;
            *) die "unknown option: $1 (try --dir <path> or --no-login)" ;;
        esac
    done

    command -v node >/dev/null 2>&1 \
        || die "agentbox needs Node.js 20 or newer, and there is no node on PATH. Install it (https://nodejs.org, or your package manager) and run this again."
    major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || die "node is on PATH but does not run"
    case "$major" in
        '' | *[!0-9]*) die "could not tell which Node.js this is" ;;
    esac
    [ "$major" -ge 20 ] || die "agentbox needs Node.js 20 or newer; this is $(node --version). Upgrade it and run this again."

    lib="${XDG_DATA_HOME:-$HOME/.local/share}/agentbox"
    mkdir -p "$lib" "$dir" || die "cannot create $lib or $dir"
    tmp="$lib/.agentbox.$$.mjs"
    trap 'rm -f "$tmp"' EXIT HUP INT TERM
    fetch "$BOX/cli/agentbox.mjs" "$tmp" || die "could not download $BOX/cli/agentbox.mjs"
    head -n 1 "$tmp" | grep -q '^#!.*node' || die "$BOX/cli/agentbox.mjs is not the agentbox CLI"
    chmod 755 "$tmp"
    version=$(node "$tmp" --version) || die "the CLI downloaded from $BOX does not run with Node.js $(node --version)"
    mv -f "$tmp" "$lib/agentbox.mjs"
    trap - EXIT HUP INT TERM
    ln -sf "$lib/agentbox.mjs" "$dir/agentbox" || die "cannot link $dir/agentbox"
    say "Installed $version at $dir/agentbox"

    case ":$PATH:" in
        *":$dir:"*) cmd=agentbox ;;
        *)
            cmd="$dir/agentbox"
            say ""
            say "$dir is not on your PATH. To add it, run this and open a new terminal:"
            case "${SHELL:-}" in
                */zsh) say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.zshrc" ;;
                */fish) say "  fish_add_path '$dir'" ;;
                */bash) say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.bashrc" ;;
                *) say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile" ;;
            esac
            ;;
    esac

    if [ "$login" = no ]; then
        say "Sign in with: $cmd login $BOX"
        return 0
    fi
    say ""
    # This script arrived on stdin; the sign-in reads nothing from it.
    "$dir/agentbox" login "$BOX" </dev/null || die "the sign-in did not finish; run \`$cmd login $BOX\` to try again"
}

main "$@"
