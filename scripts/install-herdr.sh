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

HERDR_VERSION="${HERDR_VERSION:-0.9.1}"
DEST="${1:-/usr/local/bin}"

# herdr publishes plain static binaries, not archives.
case "$(uname -m)" in
    x86_64|amd64)
        asset="herdr-linux-x86_64"
        sha="2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7"
        ;;
    aarch64|arm64)
        asset="herdr-linux-aarch64"
        sha="f4ccf4de745f2cb9a39a983e9ba3703dad50ec2a58dea83026ceab721bbd8d9e"
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
