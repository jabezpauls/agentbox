#!/usr/bin/env bash
# The release the commit checked out gets: prints vX.Y.Z.
#
#   scripts/next-version.sh [--bump patch|minor|major] [--reuse]
#
# The next version is the bump (default patch) of the highest of
#   - the release tags vX.Y.Z in this repository, and
#   - the version npm calls `latest` for @jabezpauls/agentbox,
# so a release never repeats a tag or a published npm version, whichever got
# further. With --reuse, a commit that already carries a release tag gets that
# tag again (the highest, if it has several): a re-run of a release, or a push
# of a commit already released, finishes that release instead of minting
# another.
#
# The release workflow (.github/workflows/release.yml) runs this; nothing here
# changes the repository. NPM_LATEST, when set (even empty, meaning nothing is
# published), stands in for asking npm, for tests.
set -euo pipefail

PACKAGE="@jabezpauls/agentbox"
BUMP="patch"
REUSE=false
while [ $# -gt 0 ]; do
    case "$1" in
        --bump) BUMP="${2:-}"; shift 2 ;;
        --bump=*) BUMP="${1#--bump=}"; shift ;;
        --reuse) REUSE=true; shift ;;
        *) echo "usage: scripts/next-version.sh [--bump patch|minor|major] [--reuse]" >&2; exit 2 ;;
    esac
done
case "$BUMP" in
    patch|minor|major) ;;
    *) echo "--bump is patch, minor or major, not '$BUMP'" >&2; exit 2 ;;
esac

is_release() { grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; }
# The highest of the versions (X.Y.Z, one per line) on stdin.
highest() { sort -t. -k1,1n -k2,2n -k3,3n | tail -n1; }

if [ "$REUSE" = true ]; then
    here="$(git tag --points-at HEAD | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^v//' | highest || true)"
    if [ -n "$here" ]; then
        echo "HEAD is already released as v$here" >&2
        echo "v$here"
        exit 0
    fi
fi

tagged="$(git tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^v//' | highest || true)"

if [ "${NPM_LATEST+set}" = set ]; then
    npm_latest="$NPM_LATEST"
else
    command -v npm >/dev/null || { echo "npm is needed to ask which version of $PACKAGE is latest" >&2; exit 1; }
    # A package never published is a 404, which is no version; any other
    # failure stops here rather than guess.
    err="$(mktemp)"
    trap 'rm -f "$err"' EXIT
    if ! npm_latest="$(npm view "$PACKAGE" dist-tags.latest 2>"$err")"; then
        grep -q E404 "$err" || { cat "$err" >&2; echo "could not ask npm for the latest $PACKAGE" >&2; exit 1; }
        npm_latest=""
    fi
fi
if [ -n "$npm_latest" ] && ! printf 'v%s' "$npm_latest" | is_release; then
    echo "npm's latest $PACKAGE is '$npm_latest', not X.Y.Z" >&2
    exit 1
fi

base="$(printf '%s\n' "${tagged:-0.0.0}" "${npm_latest:-0.0.0}" | highest)"
IFS=. read -r major minor patch <<<"$base"
case "$BUMP" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
esac
echo "highest tag: ${tagged:+v}${tagged:-none}, npm latest: ${npm_latest:-none}, $BUMP -> v$major.$minor.$patch" >&2
echo "v$major.$minor.$patch"
