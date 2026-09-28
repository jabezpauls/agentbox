#!/usr/bin/env bash
# The clean box's sandbox (see clean-box.sh): what the compose stack's code,
# monitor and workbench services run, in one container, as `coder`.
set -euo pipefail
cd /home/coder

# The editor: this checkout's agentbox-connect, and no start page, tips,
# chat panel or squiggles (the fixtures have no node_modules) in the pictures.
code-server --install-extension /usr/local/share/agentbox/agentbox-connect.vsix --force >/dev/null
mkdir -p .local/share/code-server/User
cat >.local/share/code-server/User/settings.json <<'JSON'
{
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.disableAIFeatures": true,
  "security.workspace.trust.enabled": false,
  "git.openRepositoryInParentFolders": "never",
  "typescript.validate.enable": false
}
JSON

# The fixture projects, and nothing else.
node /opt/agentbox-shots/seed.mjs /workspace >/dev/null

# System → Detailed monitor.
ttyd --port 7682 --base-path /monitor --check-origin btop >/dev/null 2>&1 &

# The bridge, which runs herdr.
agentbox-workbench &

exec code-server --bind-addr 0.0.0.0:8080 --auth none --disable-telemetry --disable-update-check --disable-workspace-trust --disable-proxy /workspace
