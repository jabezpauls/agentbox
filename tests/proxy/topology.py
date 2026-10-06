"""Check one compose mode's wiring; reads `docker compose config --format json` on stdin.

Prints one line per check, "ok <what>" or "FAIL <what>", and exits non-zero if
any check fails or the config cannot be read. See topology.sh.
"""
import json
import sys

mode = sys.argv[1]
cfg = json.load(sys.stdin)
svc = cfg["services"]
nets = {name: set((s.get("networks") or {}).keys()) for name, s in svc.items()}
sandbox = [n for n, s in svc.items() if n == "code" or str(s.get("network_mode", "")).startswith("service:")]
failed = False


def check(cond, msg):
    global failed
    print(("ok " if cond else "FAIL ") + msg)
    failed = failed or not cond


traefik = mode.startswith("traefik")
proxy_want = {"front", "edge"} if traefik else {"front"}
proxy_has = sorted(nets["proxy"])
gate_has = sorted(nets["gate"])
code_has = sorted(nets["code"])
check(nets["proxy"] == proxy_want, "proxy is on %s only (has %s)" % (sorted(proxy_want), proxy_has))
check(nets["gate"] == {"front", "internal"}, "gate is on front and internal (has %s)" % gate_has)
check("internal" not in nets["proxy"], "the sandbox network cannot reach the proxy")
check(all("front" not in nets.get(n, set()) for n in sandbox), "no sandbox service is on the gate-only network")
check(nets["code"] == {"internal"}, "code is on internal only (has %s)" % code_has)
published = sorted(n for n, s in svc.items() if s.get("ports"))
want = [] if traefik else ["proxy"]
check(published == want, "services publishing ports: %s" % (published or "none"))
trust = svc["proxy"].get("environment", {}).get("AGENTBOX_TRUST", "")
if mode == "traefik-passthrough":
    # Caddy is the TLS edge: the client is whom Traefik's PROXY header names,
    # and no forwarding header is believed, Cloudflare's included.
    check(trust == "standalone-off", "the proxy trusts no forwarding header (%s)" % trust)
    labels = svc["proxy"].get("labels") or {}
    check(not any(k.startswith("traefik.http.") for k in labels), "no Traefik HTTP router or middleware")
    check(labels.get("traefik.tcp.routers.agentbox.tls.passthrough") == "true"
          and labels.get("traefik.tcp.routers.agentbox.rule", "").startswith("HostSNI("),
          "a TCP router passes TLS through by SNI")
    check(labels.get("traefik.tcp.services.agentbox.loadbalancer.proxyprotocol.version") == "2",
          "Traefik names the client in a PROXY v2 header")
    env = svc["proxy"].get("environment", {})
    check(bool(env.get("AGENTBOX_PROXY_PROTOCOL_FROM", "").strip()), "the PROXY header is believed from named addresses only")
else:
    prefix = "standalone-" if mode == "standalone" else "proxied-"
    check(trust.startswith(prefix), "the proxy trusts per its mode (%s)" % trust)
# The sandbox is the trust boundary, so the editor opens every folder trusted
# (no "Restricted Mode"), and never asks for a password of its own.
code_cmd = svc["code"].get("command") or []
check("--disable-workspace-trust" in code_cmd, "the editor opens folders trusted")
check("--auth=none" in code_cmd, "the editor leaves sign-in to the gate")
check("--disable-proxy" in code_cmd, "the editor serves no port proxy")
proxy = svc["proxy"]
check(proxy.get("read_only") is True, "the proxy's filesystem is read-only")
check(proxy.get("cap_drop") == ["ALL"] and proxy.get("cap_add", []) == ["NET_BIND_SERVICE"],
      "the proxy holds no capability but binding low ports (has %s)" % proxy.get("cap_add"))
check("no-new-privileges:true" in (proxy.get("security_opt") or []), "the proxy cannot gain privileges")
# The one container that runs as root in the sandbox's image: before the
# sandbox, to hand its home back to it. Nothing but that.
init = svc["home-init"]
check(init.get("network_mode") == "none", "home-init has no network")
check(sorted(init.get("cap_add") or []) == ["CHOWN", "DAC_READ_SEARCH"] and init.get("cap_drop") == ["ALL"],
      "home-init holds only CHOWN and DAC_READ_SEARCH (has %s)" % init.get("cap_add"))
check([v.get("target") for v in init.get("volumes") or []] == ["/home/coder"], "home-init mounts the home volume only")
check("chown -h" in " ".join(init.get("entrypoint") or []), "home-init changes links, not their targets")
check((svc["code"].get("depends_on") or {}).get("home-init", {}).get("condition") == "service_completed_successfully",
      "the sandbox starts after home-init")
sys.exit(1 if failed else 0)
