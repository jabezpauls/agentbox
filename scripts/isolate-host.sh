#!/usr/bin/env bash
# Host-egress isolation, shared by install.sh and `agentbox update` so the two
# render the exact same nftables rules and systemd unit. Source this file, then
# call `agentbox_isolate_host <docker compose args...>`.
#
# It reads the running stack's subnet, renders the docs/security.md nftables
# template against it, installs it to /etc/nftables/agentbox-egress.nft, writes
# and enables the `agentbox-egress` oneshot unit, and proves from inside a
# container that the host is refused while the public internet still answers.
# It refuses on a rootless host, where a breakout lands in a user account rather
# than root and the isolation is not needed.

# shellcheck disable=SC2317  # functions are called by the sourcing script

_ih_log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
_ih_warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
_ih_die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; return 1; }

# The IPv4 entry of a network's IPAM config. A dual-stack network lists an IPv6
# subnet too, and concatenating both would render an invalid nft file.
_ih_ipv4() {
    # _ih_ipv4 <Subnet|Gateway>
    docker network inspect "${AGENTBOX_NETWORK:-agentbox_internal}" \
        --format "{{range .IPAM.Config}}{{.$1}} {{end}}" 2>/dev/null \
        | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}(/[0-9]+)?$' | head -n1
}

# A TCP port something on the host is actually listening on, reachable at the
# gateway address — so the self-check tests the firewall, not an empty port.
_ih_host_port() {
    local gw="$1"
    command -v ss >/dev/null 2>&1 || return 0
    ss -Hltn 2>/dev/null | awk -v gw="$gw" '
        { addr = $4; port = addr; sub(/.*:/, "", port); host = addr; sub(/:[^:]*$/, "", host)
          if (host == "0.0.0.0" || host == "*" || host == gw || host == "[::]") print port }' \
        | sort -n | awk '$1 == 22 { print; found = 1; exit } { if (!first) first = $1 } END { if (!found && first) print first }'
}

# The rules for one sandbox subnet. Idempotent: declaring the table first makes
# the delete safe when it does not exist yet, and the delete drops the old
# rules, so re-running (a new subnet, a changed template) replaces them rather
# than failing or stacking a second copy. `nft -f` applies the file atomically.
_ih_render_rules() {
    local subnet="$1"
    cat <<NFT
# Managed by agentbox --isolate-host. Drops the sandbox's routes to the host and
# to other private networks, while leaving the public internet reachable.
# Regenerate by re-running with --isolate-host if the subnet changes.
table inet agentbox {}
delete table inet agentbox
table inet agentbox {
	chain forward {
		type filter hook forward priority -10; policy accept;
		ct state established,related accept
		ip saddr $subnet ip daddr $subnet accept
		ip saddr $subnet ip daddr 10.0.0.0/8 drop
		ip saddr $subnet ip daddr 172.16.0.0/12 drop
		ip saddr $subnet ip daddr 192.168.0.0/16 drop
		ip saddr $subnet ip daddr 169.254.0.0/16 drop
	}
	chain input {
		type filter hook input priority -10; policy accept;
		ct state established,related accept
		ip saddr $subnet drop
	}
}
NFT
}

agentbox_isolate_host() {
    local unit="/etc/systemd/system/agentbox-egress.service"
    local rules="/etc/nftables/agentbox-egress.nft"
    local sudo="" subnet gw nft hostport

    if docker info --format '{{range .SecurityOptions}}{{.}} {{end}}' 2>/dev/null | grep -q 'name=rootless'; then
        _ih_warn "rootless Docker: a breakout lands in your user account, not root, so host isolation is not needed here. Skipping."
        return 0
    fi
    if [ "$(id -u)" -ne 0 ]; then
        command -v sudo >/dev/null 2>&1 || { _ih_die "host isolation needs root (for nft and systemd); re-run as root"; return 1; }
        sudo="sudo"
    fi
    nft="$(command -v nft || true)"
    [ -n "$nft" ] || { _ih_die "host isolation needs nftables (nft) on PATH"; return 1; }

    subnet="$(_ih_ipv4 Subnet)"
    gw="$(_ih_ipv4 Gateway)"
    [ -n "$subnet" ] || { _ih_die "could not read an IPv4 subnet for agentbox_internal; is the stack up?"; return 1; }
    _ih_log "Isolating the sandbox subnet $subnet from the host"

    $sudo mkdir -p /etc/nftables
    _ih_render_rules "$subnet" | $sudo tee "$rules" >/dev/null
    $sudo "$nft" -c -f "$rules" || { _ih_die "the rendered rules did not parse; left $rules for inspection"; return 1; }

    $sudo tee "$unit" >/dev/null <<UNIT
[Unit]
Description=agentbox sandbox egress isolation
After=firewalld.service docker.service
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$nft -f $rules
ExecStop=$nft delete table inet agentbox

[Install]
WantedBy=multi-user.target
UNIT

    $sudo systemctl daemon-reload
    $sudo systemctl enable agentbox-egress.service >/dev/null \
        || { _ih_die "failed to enable the agentbox-egress unit"; return 1; }
    # restart, not start: on a re-run the oneshot is already "active", and only
    # a restart re-applies the file just written.
    $sudo systemctl restart agentbox-egress.service \
        || { _ih_die "failed to apply the agentbox-egress rules"; return 1; }

    _ih_log "Verifying the boundary from inside the sandbox"
    if docker compose "$@" exec -T code curl -fsS --max-time 8 -o /dev/null https://api.github.com; then
        _ih_log "  public internet still reachable (api.github.com answered)"
    else
        _ih_warn "  could not reach api.github.com from the sandbox; check the rules did not over-block"
    fi
    hostport="$(_ih_host_port "$gw")"
    if [ -z "$gw" ] || [ -z "$hostport" ]; then
        _ih_warn "  found no listening host port to test against, so host isolation is applied but NOT proven; check with 'nft list table inet agentbox'"
    elif docker compose "$@" exec -T code timeout 4 bash -c "exec 3<>/dev/tcp/$gw/$hostport" 2>/dev/null; then
        _ih_warn "  the host's port $hostport answered from inside the sandbox — isolation is NOT active; inspect 'nft list table inet agentbox'"
        return 1
    else
        _ih_log "  the host is refused: port $hostport is listening on the host, and the sandbox cannot reach it"
    fi
}
