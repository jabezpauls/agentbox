#!/usr/bin/env bash
# Checks the --isolate-host rules without touching this host's firewall: the
# rendered file is applied inside a throwaway container's own network namespace.
#
#  - applying the same file twice succeeds and leaves one copy of the rules;
#  - applying a file for a new subnet replaces the old rules;
#  - on a dual-stack network the IPv4 subnet alone is chosen.
#
# Needs Docker.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=scripts/isolate-host.sh
. "$ROOT/scripts/isolate-host.sh"

FAILED=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }

WORK="$(mktemp -d)"
NET="agentbox-isolate-test-$$"
cleanup() { rm -rf "$WORK"; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT

unit="$(_ih_render_unit /usr/sbin/nft /etc/nftables/agentbox-egress.nft)"
if grep -qx 'ExecStop=-/usr/sbin/nft delete table inet agentbox' <<<"$unit"; then
    pass "stopping the unit tolerates a table that is already gone (ExecStop=-)"
else
    fail "the unit's ExecStop fails when the table is missing: $(grep ExecStop <<<"$unit")"
fi
if grep -qx 'ExecStart=/usr/sbin/nft -f /etc/nftables/agentbox-egress.nft' <<<"$unit"; then
    pass "the unit applies the rules file"
else
    fail "the unit's ExecStart: $(grep ExecStart <<<"$unit")"
fi

_ih_render_rules 10.201.12.0/24 > "$WORK/a.nft"
_ih_render_rules 10.99.0.0/24 > "$WORK/b.nft"

out="$(docker run --rm --cap-add NET_ADMIN -v "$WORK:/r:ro" debian:bookworm-slim sh -c '
    apt-get update -qq >/dev/null && apt-get install -y -qq nftables >/dev/null 2>&1
    nft -f /r/a.nft && nft -f /r/a.nft && echo APPLIED-TWICE
    echo "COPIES=$(nft list table inet agentbox | grep -c "ip saddr 10.201.12.0/24 drop")"
    nft -f /r/b.nft && echo REPLACED
    echo "OLD=$(nft list table inet agentbox | grep -c "10.201.12.0/24")"
    echo "NEW=$(nft list table inet agentbox | grep -c "ip saddr 10.99.0.0/24 drop")"
' 2>/dev/null)"
val() { printf '%s\n' "$out" | sed -n "s/^$1=//p"; }
if [[ "$out" == *APPLIED-TWICE* ]]; then pass "the same rules apply twice without error"; else fail "re-apply: $out"; fi
if [ "$(val COPIES)" = 1 ]; then pass "a re-apply leaves one copy of the rules"; else fail "copies after re-apply: $(val COPIES)"; fi
if [[ "$out" == *REPLACED* ]]; then pass "rules for a new subnet apply over the old"; else fail "replace: $out"; fi
if [ "$(val OLD)" = 0 ]; then pass "the old subnet's rules are gone"; else fail "old subnet still present: $(val OLD)"; fi
if [ "$(val NEW)" = 1 ]; then pass "the new subnet's rules are in place"; else fail "new subnet rules: $(val NEW)"; fi

docker network create --ipv6 --subnet 10.231.7.0/24 --subnet fd00:c1:7::/64 "$NET" >/dev/null
# Read as the script reads them; an empty answer is a failure to report, not
# a reason for set -e to end the check without a word.
subnet="$(AGENTBOX_NETWORK="$NET" _ih_ipv4 Subnet || true)"
gw="$(AGENTBOX_NETWORK="$NET" _ih_ipv4 Gateway || true)"
if [ "$subnet" = 10.231.7.0/24 ]; then pass "dual-stack network: IPv4 subnet chosen ($subnet)"; else
    fail "subnet parsed as '$subnet' from $(docker network inspect "$NET" --format '{{json .IPAM.Config}}')"
fi
if [[ "$gw" =~ ^10\.231\.7\.[0-9]+$ ]]; then pass "dual-stack network: IPv4 gateway chosen ($gw)"; else fail "gateway parsed as '$gw'"; fi
_ih_render_rules "$subnet" > "$WORK/c.nft"
if docker run --rm --cap-add NET_ADMIN -v "$WORK:/r:ro" debian:bookworm-slim sh -c \
    'apt-get update -qq >/dev/null && apt-get install -y -qq nftables >/dev/null 2>&1 && nft -c -f /r/c.nft' 2>/dev/null; then
    pass "the rules rendered for a dual-stack network parse"
else
    fail "dual-stack rules did not parse"
fi

[ "$FAILED" -eq 0 ] || { echo "isolate-rules check FAILED" >&2; exit 1; }
echo "isolate-rules check passed"
