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

agentbox_isolate_host() {
    local unit="/etc/systemd/system/agentbox-egress.service"
    local rules="/etc/nftables/agentbox-egress.nft"
    local sudo="" subnet gw

    if docker info --format '{{range .SecurityOptions}}{{.}} {{end}}' 2>/dev/null | grep -q 'name=rootless'; then
        _ih_warn "rootless Docker: a breakout lands in your user account, not root, so host isolation is not needed here. Skipping."
        return 0
    fi
    if [ "$(id -u)" -ne 0 ]; then
        command -v sudo >/dev/null 2>&1 || { _ih_die "host isolation needs root (for nft and systemd); re-run as root"; return 1; }
        sudo="sudo"
    fi
    command -v nft >/dev/null 2>&1 || { _ih_die "host isolation needs nftables (nft) installed"; return 1; }

    subnet="$(docker network inspect agentbox_internal \
        --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || true)"
    [ -n "$subnet" ] || { _ih_die "could not read the agentbox_internal subnet; is the stack up?"; return 1; }
    _ih_log "Isolating the sandbox subnet $subnet from the host"

    $sudo mkdir -p /etc/nftables
    $sudo tee "$rules" >/dev/null <<NFT
# Managed by agentbox --isolate-host. Drops the sandbox's routes to the host and
# to other private networks, while leaving the public internet reachable.
# Regenerate by re-running with --isolate-host if the subnet changes.
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

    $sudo tee "$unit" >/dev/null <<UNIT
[Unit]
Description=agentbox sandbox egress isolation
After=firewalld.service docker.service
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $rules
ExecStop=/usr/sbin/nft delete table inet agentbox

[Install]
WantedBy=multi-user.target
UNIT

    $sudo systemctl daemon-reload
    $sudo systemctl enable --now agentbox-egress.service \
        || { _ih_die "failed to enable the agentbox-egress unit"; return 1; }

    _ih_log "Verifying the boundary from inside the sandbox"
    gw="$(docker network inspect agentbox_internal \
        --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)"
    if docker compose "$@" exec -T code curl -fsS --max-time 8 -o /dev/null https://api.github.com; then
        _ih_log "  public internet still reachable (api.github.com answered)"
    else
        _ih_warn "  could not reach api.github.com from the sandbox; check the rules did not over-block"
    fi
    if [ -n "$gw" ] && docker compose "$@" exec -T code curl -s --max-time 4 -o /dev/null "http://$gw"; then
        _ih_warn "  the host gateway ($gw) still answered — the input drop may not be active; inspect 'nft list table inet agentbox'"
    else
        _ih_log "  the host is refused from inside the sandbox"
    fi
}
