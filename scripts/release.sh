#!/usr/bin/env bash
# Cut a release: set the version, commit, tag. Nothing is pushed.
#
#   scripts/release.sh 1.2.0        (or v1.2.0; a pre-release: 1.2.0-rc.1)
#
# Sets the version of the CLI (published to npm as @jabezpauls/agentbox) and
# of the gate, which the box reports and the CLI compares itself with, then
# commits "Release v1.2.0" and makes the annotated tag v1.2.0. Pushing the tag
# runs .github/workflows/release.yml, which tests, pushes the images to ghcr.io,
# publishes the GitHub release and the npm package. See RELEASING.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-}"
VERSION="${VERSION#v}"
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' \
    || { echo "usage: scripts/release.sh X.Y.Z" >&2; exit 2; }
TAG="v$VERSION"

cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "the working tree has changes; commit or stash them first" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "$TAG already exists" >&2; exit 1; }
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = main ] || echo "note: releasing from $branch, not main" >&2

# The two packages whose versions the box and the CLI report. Only the
# "version" line changes; the files keep their layout.
for pkg in web/cli/package.json web/gate/package.json; do
    sed -i -E "0,/\"version\": \"[^\"]*\"/s//\"version\": \"$VERSION\"/" "$pkg"
    grep -q "\"version\": \"$VERSION\"" "$pkg" || { echo "could not set the version in $pkg" >&2; exit 1; }
done
# The lockfile records workspace versions too.
(cd web && npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null)

git add web/cli/package.json web/gate/package.json web/package-lock.json
# The packages may already say this version (the first release, 0.1.0).
git diff --cached --quiet || git commit -q -m "Release $TAG"
git tag -a "$TAG" -m "agentbox $TAG"

echo "Tagged $TAG. Check it, then publish it with:"
echo "  git push origin $branch $TAG"
