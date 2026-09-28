#!/usr/bin/env bash
# The managed block the sandbox's entrypoint writes into ~/.codex/AGENTS.md:
# written on a fresh home, replaced (never duplicated) on every start, and
# everything the person wrote outside the markers kept as it was.
#
# Runs the entrypoint's own lines — cut out of images/workspace/entrypoint.sh
# between its Codex markers — against a scratch home; needs bash, awk, sed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
pass() { printf '  ok   %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*"; FAILED=1; }

# The block of the entrypoint that does it, with its paths pointed at scratch.
sed -n '/^agents=\/usr\/local\/share\/agentbox\/agents.md$/,/^fi$/p' "$ROOT/images/workspace/entrypoint.sh" \
    | sed "s|/usr/local/share/agentbox/agents.md|$WORK/agents.md|; s|/home/coder|$WORK/home|g" >"$WORK/block.sh"
grep -q 'agentbox:begin' "$WORK/block.sh" || { echo "could not find the Codex block in entrypoint.sh" >&2; exit 1; }
run() { bash "$WORK/block.sh"; }
target="$WORK/home/.codex/AGENTS.md"

printf 'instructions v1\n' >"$WORK/agents.md"
run
if [ "$(grep -c 'agentbox:begin' "$target")" = 1 ] && grep -q 'instructions v1' "$target"; then
    pass "a fresh home gets the block"
else
    fail "fresh home: $(cat "$target")"
fi

printf '\n\n# Mine\nalways use tabs\n' >>"$target"
printf 'instructions v2\n' >"$WORK/agents.md"
run
run
if [ "$(grep -c 'agentbox:begin' "$target")" = 1 ] && grep -q 'instructions v2' "$target" \
    && ! grep -q 'instructions v1' "$target" && grep -q '^always use tabs$' "$target" && grep -q '^# Mine$' "$target"; then
    pass "a restart replaces the block once and keeps the person's own lines"
else
    fail "restart: $(cat "$target")"
fi

printf '# Only mine\n' >"$target"
run
if [ "$(head -n1 "$target")" = '<!-- agentbox:begin (managed by agentbox; edits inside are replaced on restart) -->' ] \
    && [ "$(tail -n1 "$target")" = '# Only mine' ]; then
    pass "a file of the person's own gets the block on top, and keeps the rest"
else
    fail "own file: $(cat "$target")"
fi

[ "$FAILED" -eq 0 ] || { echo "codex block check FAILED" >&2; exit 1; }
echo "codex block check passed"
