"""Check one compose mode's wiring; reads `docker compose config --format json` on stdin.

    topology.py <mode> [docker]

With `docker`, the config includes docker-compose.docker.yml (Docker inside the
sandbox), and the engine's container is checked too.

Prints one line per check, "ok <what>" or "FAIL <what>", and exits non-zero if
any check fails or the config cannot be read. See topology.sh.
"""
import json
import sys

mode = sys.argv[1]
docker = sys.argv[2:] == ["docker"]
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

# The sandbox's own containers: the agents' user, no capability, no way to gain
# one, with Docker's overlay or without it.
SANDBOX = ["code", "terminal", "shell", "ssh", "monitor", "workbench"]
for name in SANDBOX:
    s = svc[name]
    check(s.get("user") == "1000:1000" and s.get("cap_drop") == ["ALL"] and not s.get("cap_add")
          and "no-new-privileges:true" in (s.get("security_opt") or []) and not s.get("privileged"),
          "%s runs as 1000 with no capability and no-new-privileges" % name)

# No container is handed a Docker socket of the host's, nor any host path but
# the proxy's own configuration, read-only.
for name, s in svc.items():
    vols = s.get("volumes") or []
    check(not any("docker.sock" in str(v.get("source", "")) or "docker.sock" in str(v.get("target", "")) for v in vols),
          "%s mounts no Docker socket" % name)
    binds = [v for v in vols if v.get("type") == "bind"]
    if name == "proxy":
        check(all(v.get("read_only") and str(v.get("target", "")).startswith("/etc/caddy/") for v in binds),
              "the proxy's host paths are its configuration, read-only")
    else:
        check(not binds, "%s mounts no host path (has %s)" % (name, [v.get("source") for v in binds]))

SOCKET_DIR = "/run/agentbox-docker"
DOCKER_HOST = "unix://%s/docker.sock" % SOCKET_DIR
if not docker:
    check("docker" not in svc, "no Docker engine unless the box turns it on")
    check(all("DOCKER_HOST" not in (svc[n].get("environment") or {}) for n in SANDBOX), "no DOCKER_HOST without it")
else:
    d = svc.get("docker")
    check(d is not None, "the Docker engine is a service of its own")
    d = d or {}
    check(not d.get("privileged"), "the engine is not privileged")
    check(not d.get("ports"), "the engine publishes no port")
    check(d.get("cap_drop") == ["ALL"] and sorted(d.get("cap_add") or []) == ["SETGID", "SETUID"],
          "the engine holds SETUID and SETGID alone (has %s)" % d.get("cap_add"))
    check(sorted(x.get("source") for x in d.get("devices") or []) == ["/dev/fuse", "/dev/net/tun"],
          "the engine's devices are /dev/fuse and /dev/net/tun")
    check(d.get("network_mode") == "service:code", "the engine shares the sandbox's network, and joins none")
    check(not d.get("networks"), "the engine is on no network of its own")
    check(not d.get("pid") and not d.get("ipc") and not d.get("userns_mode"),
          "the engine shares no process, IPC or user namespace")
    check(str(d.get("image", "")).endswith("-dind-rootless"), "the engine is the rootless image (%s)" % d.get("image"))
    check(not d.get("user") or str(d.get("user")).split(":")[0] not in ("0", "root"), "the engine does not run as root")
    # The socket's directory: one volume, in memory, only UID 1000's.
    sock = [v.get("source") for v in d.get("volumes") or [] if v.get("target") == SOCKET_DIR]
    check(len(sock) == 1, "the engine's socket is on a volume at %s" % SOCKET_DIR)
    run = cfg.get("volumes", {}).get(sock[0] if sock else "", {})
    opts = run.get("driver_opts") or {}
    o = set((opts.get("o") or "").split(","))
    check(opts.get("type") == "tmpfs" and opts.get("device") == "tmpfs", "the socket's volume is a tmpfs")
    check("uid=1000" in o and "mode=0700" in o, "the socket's volume is UID 1000's alone, mode 0700 (%s)" % opts.get("o"))
    for name in SANDBOX:
        s = svc[name]
        check((s.get("environment") or {}).get("DOCKER_HOST") == DOCKER_HOST, "%s has DOCKER_HOST" % name)
        check(any(v.get("source") in sock and v.get("target") == SOCKET_DIR for v in s.get("volumes") or []),
              "%s mounts the socket's volume" % name)
    holders = sorted(n for n, s in svc.items()
                     if any(v.get("source") in sock for v in s.get("volumes") or []))
    check(holders == sorted(SANDBOX + ["docker"]), "only the sandbox and the engine mount the socket (%s)" % holders)
    # environment is a mapping, merged across files: the Workbench keeps its own.
    check((svc["workbench"].get("environment") or {}).get("AGENTBOX_GATE_APPS_URL"), "the Workbench keeps its own environment")
check(svc["code"].get("init") is True, "the sandbox's PID 1 is an init that reaps orphans")
sys.exit(1 if failed else 0)
