#!/usr/bin/env bash
# Installing and updating from release bundles, without Docker or the network.
#
# Builds two releases of this commit (v0.0.1 and v0.0.2) with
# scripts/build-release.sh, serves them over file:// in GitHub's layout
# (AGENTBOX_RELEASE_URL), and runs the real install.sh — piped into bash, as
# the README has it — and `agentbox update` against a stand-in `docker` that
# records what it is asked. Checks that a release install pulls rather than
# builds and pins its tag, that --agents builds, that update moves between
# releases keeping .env, that a bad checksum is refused, and that a copy made
# by hand is not updated by accident.
#
# `check && pass … || fail …` throughout: pass always succeeds.
# shellcheck disable=SC2015
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAILED=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
REL="$WORK/releases"
for tag in v0.0.1 v0.0.2; do
    "$ROOT/scripts/build-release.sh" "$tag" "$REL/download/$tag" >/dev/null
done
mkdir -p "$REL/latest"
cp -R "$REL/download/v0.0.2" "$REL/latest/download"
export AGENTBOX_RELEASE_URL="file://$REL"

# A docker that does nothing but say what it was asked, and hash a password.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<EOF
#!/bin/sh
echo "\$*" >> "$WORK/calls"
case "\$*" in
    *hash-password*) cat >/dev/null; echo '\$2a\$14\$abcdefghijklmnopqrstuuKO0DUaDUZ9L.Qq0OZ9nZ5tQmZ6q1pO' ;;
    *"config --images"*) echo stand-in/image:tag ;;
esac
exit 0
EOF
chmod +x "$WORK/bin/docker"
export PATH="$WORK/bin:$PATH"

BOX="$WORK/box"
get() { grep -m1 "^$1=" "$BOX/.env" | cut -d= -f2-; }
expect() {
    if [ "$(get "$1")" = "$2" ]; then pass "$3"; else fail "$3 ($1='$(get "$1")', wanted '$2')"; fi
}
called() { grep -q -- "$1" "$WORK/calls"; }

echo "a new install, piped into bash, installs the release it came with"
rm -f "$WORK/calls"
if (cd "$WORK" && bash -s -- --mode behind-proxy --dir "$BOX" --yes --password abcdefgh1 \
        < "$REL/download/v0.0.1/install.sh") >"$WORK/out" 2>&1; then
    pass "install.sh ran"
else
    fail "install.sh failed: $(tail -5 "$WORK/out")"
fi
[ "$(cat "$BOX/VERSION" 2>/dev/null)" = v0.0.1 ] && pass "the v0.0.1 bundle is unpacked" || fail "VERSION is '$(cat "$BOX/VERSION" 2>/dev/null)'"
[ -f "$BOX/docker-compose.yml" ] && [ -x "$BOX/scripts/agentbox" ] && [ -f "$BOX/proxy/Caddyfile.standalone" ] \
    && pass "with its compose files, scripts and proxy configuration" || fail "the bundle is missing files"
[ -f "$BOX/images/workspace/Dockerfile" ] && [ -f "$BOX/web/package-lock.json" ] \
    && pass "and the image sources, for a box that builds its own" || fail "the bundle has no image sources"
[ ! -e "$BOX/.git" ] && [ ! -e "$BOX/tests" ] && pass "and nothing a box does not need" || fail "the bundle carries .git or tests"
expect AGENTBOX_TAG v0.0.1 "the tag is pinned in .env"
expect AGENTBOX_VERSION v0.0.1 "and is the version the box reports"
expect AGENTBOX_RELEASE_URL "file://$REL" "the release server is kept for updates"
called "compose -f docker-compose.yml -f docker-compose.behind-proxy.yml pull" && pass "the images are pulled" || fail "no pull: $(cat "$WORK/calls")"
called " build" && fail "a release install built images" || pass "and not built"
called "up -d --no-build --remove-orphans" && pass "the stack is started without building" || fail "no up -d --no-build"
grep -q '^AGENTBOX_WORKSPACE_IMAGE=' "$BOX/.env" && fail "a release install names a local image" || pass "the release's own images are used"
sed -i 's/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=sk-ant-keepme/' "$BOX/.env"
echo "MY_OWN_SETTING=keep me" >> "$BOX/.env"
hash="$(get AGENTBOX_PASSWORD_HASH)"

echo "a new install without --password generates one, and prints it once"
if (cd "$WORK" && bash -s -- --mode behind-proxy --dir "$WORK/box2" --yes \
        < "$REL/download/v0.0.1/install.sh") >"$WORK/out" 2>&1 \
    && grep -Eq '^  Password  [a-z0-9]{20}$' "$WORK/out"; then
    pass "a 20-character password is generated"
else
    fail "no generated password: $(tail -5 "$WORK/out")"
fi
rm -rf "$WORK/box2"

echo "a re-run keeps the release it has"
rm -f "$WORK/calls"
bash "$BOX/install.sh" --yes >/dev/null 2>&1 || fail "re-run failed"
expect AGENTBOX_TAG v0.0.1 "still v0.0.1"
expect AGENTBOX_MODE behind-proxy "settings kept"

echo "agentbox update moves to the latest release"
rm -f "$WORK/calls"
if (cd / && "$BOX/scripts/agentbox" update) >"$WORK/out" 2>&1; then pass "update ran"; else fail "update failed: $(tail -5 "$WORK/out")"; fi
[ "$(cat "$BOX/VERSION")" = v0.0.2 ] && pass "the v0.0.2 files are in place" || fail "VERSION is $(cat "$BOX/VERSION")"
grep -q '^DEFAULT_RELEASE="v0.0.2"' "$BOX/install.sh" && pass "install.sh is the new release's" || fail "install.sh not replaced"
expect AGENTBOX_TAG v0.0.2 "the tag moves to v0.0.2"
expect AGENTBOX_VERSION v0.0.2 "and the version with it"
expect ANTHROPIC_API_KEY sk-ant-keepme ".env keeps its API keys"
expect MY_OWN_SETTING "keep me" "and keys added by hand"
expect AGENTBOX_PASSWORD_HASH "$hash" "and the password"
called "pull" && called "up -d --no-build --remove-orphans" && pass "then pulls and restarts" || fail "update did not pull and restart"

echo "update --version pins a release, and says when it is already there"
(cd / && "$BOX/scripts/agentbox" update --version 0.0.1) >/dev/null 2>&1 || fail "update --version failed"
expect AGENTBOX_TAG v0.0.1 "--version 0.0.1 goes back to v0.0.1"
(cd / && "$BOX/scripts/agentbox" update --version v0.0.1) >"$WORK/out" 2>&1 || true
grep -q "Already on agentbox v0.0.1" "$WORK/out" && pass "and a second time says it is already there" || fail "no 'already' note: $(cat "$WORK/out")"
if (cd / && "$BOX/scripts/agentbox" update --version v9.9.9) >/dev/null 2>&1; then fail "update to a missing release succeeded"; else pass "a release that does not exist is refused"; fi
expect AGENTBOX_TAG v0.0.1 "leaving the tag as it was"

echo "--agents other than the prebuilt pair builds the image here"
rm -f "$WORK/calls"
(cd / && "$BOX/scripts/agentbox" update --version v0.0.1 --agents claude) >/dev/null 2>&1 || fail "update --agents claude failed"
called "build --pull" && pass "it builds" || fail "no build: $(cat "$WORK/calls")"
expect AGENTBOX_WORKSPACE_IMAGE agentbox/workspace:latest "under a local name, never the registry's"
expect AGENTBOX_GATE_IMAGE agentbox/gate:latest "the gate too"
rm -f "$WORK/calls"
(cd / && "$BOX/scripts/agentbox" update --version v0.0.1 --agents codex,claude) >/dev/null 2>&1 || fail "update back to the pair failed"
called " build" && fail "the default pair (in any order) still builds" || pass "the default pair, in any order, pulls again"
grep -q '^AGENTBOX_WORKSPACE_IMAGE=' "$BOX/.env" && fail "the local name stayed" || pass "and the local names go"
(cd / && "$BOX/scripts/agentbox" update --version v0.0.1 --build) >/dev/null 2>&1 || true
rm -f "$WORK/calls"
(cd / && "$BOX/scripts/agentbox" apply) >/dev/null 2>&1 || true
called "build --pull" && pass "--build makes even the default pair build" || fail "--build did not stick"
(cd / && "$BOX/scripts/agentbox" update --version v0.0.1 --no-build) >/dev/null 2>&1 || true
expect AGENTBOX_BUILD off "--no-build turns it off"

echo "Docker inside the sandbox is an overlay of its own"
[ -f "$BOX/docker-compose.docker.yml" ] && pass "the release carries docker-compose.docker.yml" || fail "the bundle has no Docker overlay"
WITH="compose -f docker-compose.yml -f docker-compose.behind-proxy.yml -f docker-compose.docker.yml"
rm -f "$WORK/calls"
(cd / && "$BOX/scripts/agentbox" update --version v0.0.1 --docker on) >/dev/null 2>&1 || fail "update --docker on failed"
expect AGENTBOX_DOCKER on "update --docker on is written"
called "$WITH pull" && called "$WITH up -d --no-build --remove-orphans" \
    && pass "the stack is pulled and started with the overlay" || fail "no overlay: $(cat "$WORK/calls")"
called "$WITH config --images" && pass "and its images are checked, the engine's included" || fail "images not checked with the overlay"
rm -f "$WORK/calls"
bash "$BOX/install.sh" --yes --password abcdefgh2 >/dev/null 2>&1 || fail "re-run with a new password failed"
expect AGENTBOX_DOCKER on "a re-run of install.sh keeps Docker on"
called "$WITH exec -T gate agentbox-gate set-password" && pass "and reaches the gate through the same files" || fail "install.sh's gate command: $(grep gate "$WORK/calls")"
rm -f "$WORK/calls"
(cd / && "$BOX/scripts/agentbox" update --version v0.0.1 --build) >/dev/null 2>&1 || true
called "$WITH build --pull" && called "$WITH pull --quiet docker" \
    && pass "a box that builds its images still pulls the engine's" || fail "build with Docker on: $(cat "$WORK/calls")"
(cd / && "$BOX/scripts/agentbox" update --version v0.0.1 --no-build) >/dev/null 2>&1 || true
rm -f "$WORK/calls"
(cd / && "$BOX/scripts/agentbox" update --version v0.0.1 --docker off) >/dev/null 2>&1 || fail "update --docker off failed"
expect AGENTBOX_DOCKER off "update --docker off is written"
called "docker-compose.docker.yml" && fail "the overlay is still composed: $(cat "$WORK/calls")" \
    || { called "compose -f docker-compose.yml -f docker-compose.behind-proxy.yml up -d --no-build --remove-orphans" \
        && pass "the stack restarts without it, removing the engine's container" || fail "no restart: $(cat "$WORK/calls")"; }

echo "a download that does not match its checksums is refused"
"$ROOT/scripts/build-release.sh" v0.0.3 "$REL/download/v0.0.3" >/dev/null
sed -i 's/^[0-9a-f]\{64\}  agentbox.tar.gz$/0000000000000000000000000000000000000000000000000000000000000000  agentbox.tar.gz/' "$REL/download/v0.0.3/SHA256SUMS"
if (cd / && "$BOX/scripts/agentbox" update --version v0.0.3) >"$WORK/out" 2>&1; then
    fail "a corrupt release was installed"
else
    grep -q "SHA256SUMS" "$WORK/out" && pass "update refuses it" || fail "refused, but not for the checksum: $(cat "$WORK/out")"
fi
[ "$(cat "$BOX/VERSION")" = v0.0.1 ] && pass "and changes no file" || fail "files changed: VERSION $(cat "$BOX/VERSION")"
expect AGENTBOX_TAG v0.0.1 "nor the tag"

echo "a tampered bundle is refused before it is unpacked"
"$ROOT/scripts/build-release.sh" v0.0.4 "$REL/download/v0.0.4" >/dev/null
printf 'not a tarball\n' > "$REL/download/v0.0.4/agentbox.tar.gz"
if (cd / && "$BOX/scripts/agentbox" update --version v0.0.4) >"$WORK/out" 2>&1; then
    fail "a tampered bundle was installed"
else
    grep -q "does not match the release's SHA256SUMS" "$WORK/out" && ! grep -q "valid archive" "$WORK/out" \
        && pass "the checksum stops it, before tar reads it" || fail "not stopped by the checksum: $(cat "$WORK/out")"
fi

echo "a release without SHA256SUMS is refused, unless verification is skipped in so many words"
"$ROOT/scripts/build-release.sh" v0.0.5 "$REL/download/v0.0.5" >/dev/null
rm "$REL/download/v0.0.5/SHA256SUMS"
if (cd / && "$BOX/scripts/agentbox" update --version v0.0.5) >"$WORK/out" 2>&1; then
    fail "update installed a release it could not check"
else
    grep -q "AGENTBOX_INSECURE_SKIP_VERIFY=1" "$WORK/out" && pass "update refuses it, and names the opt-out" || fail "refused oddly: $(cat "$WORK/out")"
fi
expect AGENTBOX_TAG v0.0.1 "leaving the box on v0.0.1"
if (cd "$WORK" && bash -s -- --mode behind-proxy --dir "$WORK/box5" --yes --password abcdefgh1 --version v0.0.5 \
        < "$REL/download/v0.0.1/install.sh") >"$WORK/out" 2>&1; then
    fail "install.sh installed a release it could not check"
else
    [ ! -e "$WORK/box5/VERSION" ] && pass "install.sh refuses it too, unpacking nothing" || fail "install.sh unpacked it"
fi
(cd / && AGENTBOX_INSECURE_SKIP_VERIFY=1 "$BOX/scripts/agentbox" update --version v0.0.5) >"$WORK/out" 2>&1 || true
expect AGENTBOX_TAG v0.0.5 "AGENTBOX_INSECURE_SKIP_VERIFY=1 lets a mirror without checksums through"
grep -q "unchecked" "$WORK/out" && pass "with a warning" || fail "no warning: $(cat "$WORK/out")"
(cd / && "$BOX/scripts/agentbox" update --version v0.0.1) >/dev/null 2>&1 || fail "back to v0.0.1 failed"
rm -rf "$WORK/box5"

echo "where a new install goes, and an existing one stays"
# where <uid> <home>: the directory install.sh's own function picks for that
# user, with no --dir (the function alone, with `id -u` answering <uid>).
where() {
    # shellcheck disable=SC2016  # the inner script's $0 and $(…) are its own
    env -u SUDO_USER HOME="$2" UID_SAYS="$1" bash -c \
        'eval "$(sed -n "/^default_install_dir() {/,/^}/p" "$0")"; id() { echo "$UID_SAYS"; }; default_install_dir' "$ROOT/install.sh"
}
H="$WORK/home"; mkdir -p "$H/root" "$H/alice"
if [ ! -e /opt/agentbox/docker-compose.yml ]; then
    [ "$(where 0 "$H/root")" = /opt/agentbox ] && pass "as root (or under sudo), /opt/agentbox" || fail "root default: $(where 0 "$H/root")"
    mkdir -p "$H/root/agentbox" && touch "$H/root/agentbox/docker-compose.yml"
    [ "$(where 0 "$H/root")" = "$H/root/agentbox" ] && pass "an install already in root's home stays there" || fail "root's existing install: $(where 0 "$H/root")"
fi
[ "$(where 1000 "$H/alice")" = "$H/alice/agentbox" ] && pass "as a user with Docker access, ~/agentbox" || fail "user default: $(where 1000 "$H/alice")"

echo "a root install's commands, run without sudo, say to use sudo"
chmod 000 "$BOX/.env"
if [ "$(id -u)" != 0 ]; then
    if (cd / && "$BOX/scripts/agentbox" status) >"$WORK/out" 2>&1; then fail "ran with an unreadable .env"; else
        grep -q "run: sudo" "$WORK/out" && pass "it says to run it with sudo" || fail "no pointer to sudo: $(cat "$WORK/out")"
    fi
fi
chmod 600 "$BOX/.env"

echo "a copy made by hand is not updated by accident"
COPY="$WORK/copy"
mkdir -p "$COPY/scripts"
cp "$ROOT/scripts/agentbox" "$ROOT/scripts/isolate-host.sh" "$COPY/scripts/"
touch "$COPY/docker-compose.yml"
printf 'AGENTBOX_MODE=traefik\nAGENTBOX_TLS=passthrough\n' > "$COPY/.env"
if (cd / && "$COPY/scripts/agentbox" update) >"$WORK/out" 2>&1; then
    fail "update ran on a copy made by hand"
else
    grep -q -- "--version latest" "$WORK/out" && pass "update refuses, and says how to move it onto releases" || fail "refused without a way forward: $(cat "$WORK/out")"
fi
[ ! -e "$COPY/VERSION" ] && pass "and changes nothing" || fail "the copy was changed"

echo "a box from before releases, a git clone, keeps building, and moves onto releases in place"
CLONE="$WORK/clone"
mkdir -p "$WORK/upstream"
git -C "$ROOT" archive HEAD | tar -x -C "$WORK/upstream"
git -C "$WORK/upstream" -c init.defaultBranch=main init -q
git -C "$WORK/upstream" add -A
git -C "$WORK/upstream" -c user.name=t -c user.email=t@example.com commit -q -m old
git clone -q "$WORK/upstream" "$CLONE"
# Its .env, as an installer from before releases wrote it.
grep -v '^AGENTBOX_\(TAG\|BUILD\|RELEASE_URL\|WORKSPACE_IMAGE\|GATE_IMAGE\)=' "$BOX/.env" > "$CLONE/.env"
sed -i 's/^AGENTBOX_VERSION=.*/AGENTBOX_VERSION=abc1234/' "$CLONE/.env"
rm -f "$WORK/calls"
(cd / && AGENTBOX_RELEASE_URL='' "$CLONE/scripts/agentbox" update) >"$WORK/out" 2>&1 || fail "update in a clone failed: $(tail -3 "$WORK/out")"
called "build --pull" && pass "update in a clone pulls the code and builds" || fail "no build in a clone"
cget() { grep -m1 "^$1=" "$CLONE/.env" | cut -d= -f2-; }
[ "$(cget AGENTBOX_WORKSPACE_IMAGE)" = agentbox/workspace:latest ] && pass "under the names it always had" || fail "clone image: '$(cget AGENTBOX_WORKSPACE_IMAGE)'"
mv "$CLONE/.git" "$WORK/clone-git-backup"
rm -f "$WORK/calls"
(cd / && "$CLONE/scripts/agentbox" update --version latest) >"$WORK/out" 2>&1 || fail "moving onto releases failed: $(tail -3 "$WORK/out")"
[ "$(cget AGENTBOX_TAG)" = v0.0.2 ] && pass "update --version latest pins the latest release" || fail "tag: '$(cget AGENTBOX_TAG)'"
called " build" && fail "it still builds" || pass "and pulls its images"
[ -z "$(cget AGENTBOX_WORKSPACE_IMAGE)" ] && pass "the local image names go" || fail "local names stayed"
[ "$(cget ANTHROPIC_API_KEY)" = sk-ant-keepme ] && [ "$(cget AGENTBOX_PASSWORD_HASH)" = "$hash" ] \
    && pass "and .env is kept" || fail ".env lost keys"

[ "$FAILED" -eq 0 ] || { echo "release check FAILED" >&2; exit 1; }
echo "release check passed"
