#!/usr/bin/env bash
# Build a release's files: the bundle install.sh downloads, the installer
# itself, and their checksums.
#
#   scripts/build-release.sh v1.2.0 [out-dir]     (default out-dir: dist/release)
#
# The bundle, agentbox.tar.gz (and the same file as agentbox-v1.2.0.tar.gz), is
# everything an install needs but the images: the compose files, the proxy
# configuration, the scripts, .env.example, the runtime docs, a VERSION file
# naming the release, and the sources of the two images, so a box with its own
# --agents (or --build) can build them. It is made from the commit checked out
# (git archive HEAD), never from uncommitted changes, so it is the same
# wherever it is built. install.sh is stamped with the release, so a copy
# downloaded from a release installs that release.
set -euo pipefail

TAG="${1:-}"
printf '%s' "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' \
    || { echo "usage: scripts/build-release.sh vX.Y.Z [out-dir]" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${2:-$ROOT/dist/release}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

# What a box needs at runtime, and what building its images needs.
PATHS=(
    install.sh .env.example .dockerignore
    docker-compose.yml docker-compose.standalone.yml docker-compose.behind-proxy.yml
    docker-compose.traefik.yml docker-compose.traefik-passthrough.yml docker-compose.previews.yml
    proxy scripts images web
    README.md LICENSE docs/install.md docs/cli.md docs/security.md docs/workbench.md
)

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
NAME="agentbox-$TAG"
mkdir -p "$STAGE/$NAME"
git -C "$ROOT" archive --format=tar HEAD -- "${PATHS[@]}" | tar -x -C "$STAGE/$NAME"
printf '%s\n' "$TAG" > "$STAGE/$NAME/VERSION"
# The installer installs its own release unless told otherwise.
sed -i "s/^DEFAULT_RELEASE=\"\"/DEFAULT_RELEASE=\"$TAG\"/" "$STAGE/$NAME/install.sh"
grep -q "^DEFAULT_RELEASE=\"$TAG\"" "$STAGE/$NAME/install.sh" \
    || { echo "could not stamp install.sh with $TAG" >&2; exit 1; }
# The CLI and the gate say the release too, so what a box builds from these
# sources (--agents, --build) reports it even without AGENTBOX_VERSION. The
# repository's own versions are not release numbers: releases are stamped,
# never committed (see RELEASING.md).
for pkg in web/cli/package.json web/gate/package.json; do
    sed -i -E "0,/\"version\": \"[^\"]*\"/s//\"version\": \"${TAG#v}\"/" "$STAGE/$NAME/$pkg"
    grep -q "\"version\": \"${TAG#v}\"" "$STAGE/$NAME/$pkg" \
        || { echo "could not stamp $pkg with $TAG" >&2; exit 1; }
done

# Reproducible: fixed order, owner and times, and no name or time in the gzip
# header, so two builds of one commit are byte for byte the same.
MTIME="$(git -C "$ROOT" log -1 --format=%cI HEAD)"
tar -C "$STAGE" --sort=name --owner=0 --group=0 --numeric-owner --mtime="$MTIME" \
    -cf - "$NAME" | gzip -9n > "$OUT/$NAME.tar.gz"
cp "$OUT/$NAME.tar.gz" "$OUT/agentbox.tar.gz"
cp "$STAGE/$NAME/install.sh" "$OUT/install.sh"
chmod 0755 "$OUT/install.sh"
(cd "$OUT" && sha256sum agentbox.tar.gz "$NAME.tar.gz" install.sh > SHA256SUMS)

echo "built $TAG in $OUT:"
(cd "$OUT" && ls -l agentbox.tar.gz "$NAME.tar.gz" install.sh SHA256SUMS)
