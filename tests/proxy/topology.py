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


proxy_want = {"front", "edge"} if mode == "traefik" else {"front"}
proxy_has = sorted(nets["proxy"])
gate_has = sorted(nets["gate"])
code_has = sorted(nets["code"])
check(nets["proxy"] == proxy_want, "proxy is on %s only (has %s)" % (sorted(proxy_want), proxy_has))
check(nets["gate"] == {"front", "internal"}, "gate is on front and internal (has %s)" % gate_has)
check("internal" not in nets["proxy"], "the sandbox network cannot reach the proxy")
check(all("front" not in nets.get(n, set()) for n in sandbox), "no sandbox service is on the gate-only network")
check(nets["code"] == {"internal"}, "code is on internal only (has %s)" % code_has)
published = sorted(n for n, s in svc.items() if s.get("ports"))
want = [] if mode == "traefik" else ["proxy"]
check(published == want, "services publishing ports: %s" % (published or "none"))
trust = svc["proxy"].get("environment", {}).get("AGENTBOX_TRUST", "")
prefix = "standalone-" if mode == "standalone" else "proxied-"
check(trust.startswith(prefix), "the proxy trusts per its mode (%s)" % trust)
sys.exit(1 if failed else 0)
