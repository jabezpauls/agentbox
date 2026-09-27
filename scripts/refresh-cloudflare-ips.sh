#!/usr/bin/env bash
# Cloudflare's published edge ranges, as Caddy trusts them when the box is
# behind Cloudflare (proxy/trust/*-on.caddy).
#
#   scripts/refresh-cloudflare-ips.sh           fetch https://www.cloudflare.com/ips-v4
#                                               and /ips-v6 and rewrite both files
#   scripts/refresh-cloudflare-ips.sh --check   no network: the two files must list
#                                               the same ranges (CI runs this)
#
# Cloudflare changes these rarely and announces it; refresh, review the diff,
# commit, and `./scripts/agentbox update` picks it up.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILES=("$ROOT/proxy/trust/standalone-on.caddy" "$ROOT/proxy/trust/proxied-on.caddy")

# The ranges a file trusts, one per line, private_ranges aside.
ranges_in() {
    grep -m1 '^trusted_proxies static ' "$1" | cut -d' ' -f3- | tr ' ' '\n' | grep -v '^private_ranges$'
}

if [ "${1:-}" = "--check" ]; then
    a="$(ranges_in "${FILES[0]}")"
    b="$(ranges_in "${FILES[1]}")"
    [ -n "$a" ] || { echo "no Cloudflare ranges in ${FILES[0]}" >&2; exit 1; }
    if [ "$a" != "$b" ]; then
        echo "the two trust files list different Cloudflare ranges; run $0" >&2
        exit 1
    fi
    echo "Cloudflare ranges agree ($(printf '%s\n' "$a" | wc -l) ranges)"
    exit 0
fi

v4="$(curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4)"
v6="$(curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6)"
list="$(printf '%s\n%s\n' "$v4" "$v6" | grep -E '^[0-9a-fA-F:.]+/[0-9]+$' | tr '\n' ' ' | sed 's/ $//')"
[ -n "$list" ] || { echo "fetched no ranges; nothing changed" >&2; exit 1; }

for f in "${FILES[@]}"; do
    if grep -q '^trusted_proxies static private_ranges ' "$f"; then
        line="trusted_proxies static private_ranges $list"
    else
        line="trusted_proxies static $list"
    fi
    tmp="$(mktemp)"
    awk -v line="$line" '/^trusted_proxies static / { print line; next } { print }' "$f" > "$tmp"
    mv "$tmp" "$f"
done
echo "rewrote ${#FILES[@]} files with $(printf '%s' "$list" | wc -w) ranges"
