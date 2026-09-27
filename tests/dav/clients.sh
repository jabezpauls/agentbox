#!/usr/bin/env bash
# The workspace over WebDAV, driven by real clients: the litmus compliance
# suite and rclone, each in its own container, against the real bridge build.
#
# What must hold: litmus's basic, copymove and http suites pass whole, and
# its locks and props suites fail only where a dead property is set (the
# bridge deliberately stores none; see docs/workbench.md). rclone copies a
# tree up and back byte for byte, copies and moves server-side, deletes,
# purges and syncs.
#
# Needs Docker, Node 22 and the bridge built:
#   (cd web && npm ci && npm run build -w bridge)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${DAV_PORT:-7899}"
LITMUS_IMAGE="${LITMUS_IMAGE:-owncloud/litmus:latest}"
RCLONE_IMAGE="${RCLONE_IMAGE:-rclone/rclone:latest}"
URL="http://127.0.0.1:$PORT/api/dav/"

[ -f "$ROOT/web/bridge/dist/bridge/src/app.js" ] \
    || { echo "build the bridge first: (cd web && npm ci && npm run build -w bridge)" >&2; exit 2; }

WORK="$(mktemp -d)"
LOG="$WORK/harness.log"
node "$ROOT/tests/dav/harness.mjs" "$PORT" >"$LOG" 2>&1 &
HARNESS=$!
cleanup() {
    kill "$HARNESS" 2>/dev/null || true
    wait "$HARNESS" 2>/dev/null || true
    rm -rf "$WORK"
}
trap cleanup EXIT

for _ in $(seq 1 50); do
    grep -q READY "$LOG" 2>/dev/null && break
    sleep 0.2
done
grep -q READY "$LOG" || { echo "bridge harness did not start:" >&2; cat "$LOG" >&2; exit 1; }

FAILED=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }

# litmus <suite> <allowed failing test names, space-separated>
litmus() {
    local suite="$1" allowed="$2" out failures name
    out="$(docker run --rm --network host -e TESTS="$suite" "$LITMUS_IMAGE" "$URL" 2>&1 || true)"
    if ! grep -q "summary for \`$suite'" <<<"$out"; then
        fail "litmus $suite did not run"; printf '%s\n' "$out" | tail -20; return
    fi
    # litmus redraws each test's line after a carriage return, so the verdict
    # is not at the start of a line.
    failures="$(grep -oE '[0-9]+\. [a-z_0-9]+\.* FAIL' <<<"$out" | sed -E 's/^[0-9]+\. ([a-z_0-9]+).*/\1/' | sort -u || true)"
    for name in $failures; do
        case " $allowed " in
            *" $name "*) ;;
            *) fail "litmus $suite: $name"; printf '%s\n' "$out" | grep -E "FAIL" >&2; return ;;
        esac
    done
    pass "litmus $suite ($(grep "summary for" <<<"$out" | sed 's/.*: of //'))"
}

printf '\n== litmus\n'
litmus basic ""
litmus copymove ""
litmus http ""
# PROPPATCH of a dead property is refused by design; everything else passes.
litmus props "propset propmanyns propget"
litmus locks "owner_modify"

printf '\n== rclone\n'
mkdir -p "$WORK/up/sub/deeper" "$WORK/sync"
printf 'alpha\n' >"$WORK/up/a.txt"
printf 'bravo\n' >"$WORK/up/b.txt"
printf 'semi\n' >"$WORK/up/semi;colon.txt"
printf 'uni\n' >"$WORK/up/ünïcödé.txt"
printf 'deep\n' >"$WORK/up/sub/deeper/c.txt"
head -c 5000000 /dev/urandom >"$WORK/up/sub/big.bin"
printf 'only this\n' >"$WORK/sync/new.txt"
R=":webdav,url='$URL',vendor=other:"
rc() { docker run --rm --network host -v "$WORK:/w" "$RCLONE_IMAGE" -q "$@"; }
step() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then pass "rclone: $what"; else fail "rclone: $what"; fi; }
same() { [ "$(rc cat "${R}$1")" = "$2" ]; }
listing() { [ "$(rc lsf -R "${R}$1")" = "$2" ]; }

step "copy a tree up"            rc copy /w/up "${R}rc"
step "download and compare"      rc check /w/up "${R}rc" --download
step "server-side copy"          rc copyto "${R}rc/b.txt" "${R}rc/b2.txt"
step "server-side move"          rc moveto "${R}rc/a.txt" "${R}rc/moved.txt"
step "moved content"             same rc/moved.txt alpha
step "delete a file"             rc deletefile "${R}rc/b2.txt"
step "purge a directory"         rc purge "${R}rc/sub/deeper"
step "sync deletes extras"       rc sync /w/sync "${R}rc"
step "only the synced file left" listing rc new.txt

printf '\n'
if [ "$FAILED" -ne 0 ]; then
    echo "WebDAV client check FAILED" >&2
    exit 1
fi
echo "WebDAV client check passed"
