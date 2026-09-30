#!/usr/bin/env sh
# Install the pinned herdr binary.
#
# The version and its checksums live here and nowhere else: the sandbox image
# and CI both call this script, so the build and the end-to-end tests can never
# drift onto different herdr releases.
#
#   scripts/install-herdr.sh [destination-directory]   (default /usr/local/bin)
#
# Deliberately POSIX sh with no dependencies beyond curl and sha256sum, so it
# runs in the Debian build stage as readily as on a CI runner.
set -eu

HERDR_VERSION="${HERDR_VERSION:-0.9.3}"
DEST="${1:-/usr/local/bin}"

# herdr publishes plain static binaries, not archives.
case "$(uname -m)" in
    x86_64|amd64)
        asset="herdr-linux-x86_64"
        sha="18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7"
        ;;
    aarch64|arm64)
        asset="herdr-linux-aarch64"
        sha="4de7aa3e25678812e92960de64f7c2aaa1bca1f0f80a3c5e559837e231e1f5c0"
        ;;
    *)
        echo "unsupported architecture: $(uname -m)" >&2
        exit 1
        ;;
esac

mkdir -p "$DEST"
curl -fsSL -o "$DEST/herdr" \
    "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/${asset}"
echo "${sha}  ${DEST}/herdr" | sha256sum -c -
chmod 0755 "$DEST/herdr"
"$DEST/herdr" --version
