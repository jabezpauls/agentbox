#!/usr/bin/env bash
# The version a push to main releases as (scripts/next-version.sh), against
# throwaway repositories, with npm's answer stood in by NPM_LATEST.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAILED=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com

# repo NAME TAG... : a repository whose commits are tagged, one tag each, in order.
repo() {
    local dir="$WORK/$1"; shift
    git init -q "$dir"
    git -C "$dir" commit -q --allow-empty -m first
    for tag in "$@"; do
        git -C "$dir" tag "$tag"
        git -C "$dir" commit -q --allow-empty -m "after $tag"
    done
}
# expect WANT DIR [NPM_LATEST] [ARGS...]
expect() {
    local want="$1" dir="$2" npm="$3"; shift 3
    local got
    if got="$(cd "$WORK/$dir" && NPM_LATEST="$npm" "$ROOT/scripts/next-version.sh" "$@" 2>/dev/null)"; then :; else got="(failed)"; fi
    if [ "$got" = "$want" ]; then pass "$dir ${*:-} npm=${npm:-none}: $want"; else fail "$dir ${*:-} npm=${npm:-none}: wanted $want, got $got"; fi
}

repo tagged v0.1.0 v0.1.5
expect v0.1.6 tagged ""
expect v0.1.6 tagged 0.1.0
expect v0.2.0 tagged "" --bump minor
expect v1.0.0 tagged "" --bump major
# npm got further than the tags: never at or below it.
expect v0.1.10 tagged 0.1.9

repo untagged
expect v0.1.1 untagged 0.1.0
expect v0.0.1 untagged ""

# Sorted as numbers, not text; tags that are not releases are ignored.
repo numeric v0.9.0 v0.10.0 v1.0.0-rc.1 nightly
expect v0.10.1 numeric ""

repo minor v0.1.6
expect v0.2.0 minor "" --bump minor
expect v0.2.0 minor "" --bump=minor

# A commit already released: --reuse gives its tag back, the highest if two.
git -C "$WORK/minor" tag v0.1.7
expect v0.1.7 minor "" --reuse
git -C "$WORK/minor" tag v0.2.0
expect v0.2.0 minor 0.2.0 --reuse
# Without --reuse (a fresh minor on a released commit) it is bumped again.
expect v0.3.0 minor 0.2.0 --bump minor
# --reuse on an unreleased commit is the plain next version.
expect v0.1.6 tagged "" --reuse

expect "(failed)" tagged "" --bump huge
expect "(failed)" tagged "1.0"

exit "$FAILED"
