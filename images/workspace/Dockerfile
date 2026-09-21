# The sandbox image: an editor, a shell, a process monitor, the Workbench, and
# the coding agents — all runnable as an unprivileged user.
#
# Built from the repository root (see docker-compose.yml) so the web workspace
# can be compiled here: one image carries everything, and an update is a single
# rebuild rather than a separate artefact to keep in step.

# The Workbench: its React app and the bridge that serves it, compiled once and
# copied into the sandbox image below. Nothing from this stage but the build
# output survives, so Node's build tooling never ships.
FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY web/package.json web/package-lock.json ./
COPY web/shared/package.json shared/
COPY web/bridge/package.json bridge/
COPY web/app/package.json app/
RUN npm ci
COPY web/ .
RUN npm run build && npm prune --omit=dev

FROM debian:bookworm-slim

ARG NODE_MAJOR=22
# ttyd is not packaged by Debian; pin the upstream static build.
ARG TTYD_VERSION=1.7.7
# Set to "false" to build without the coding agents (smaller image).
ARG INSTALL_AGENTS=true

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/coder \
    SHELL=/bin/bash \
    # npm must not try to write to a root-owned prefix at runtime.
    NPM_CONFIG_PREFIX=/home/coder/.npm-global \
    PATH=/home/coder/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin:/usr/bin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git openssh-client \
        passwd adduser \
        bash less nano vim \
        ripgrep fd-find jq unzip zip \
        python3 python3-venv python3-pip \
        btop procps htop \
        tmux \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI, from its own apt repository (Debian does not package it).
RUN mkdir -p -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && gh --version

# ttyd powers the full-screen shell and the process monitor. Debian does not
# ship it, so take the upstream static binary for this architecture.
RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) ttyd_arch=x86_64 ;; \
         arm64) ttyd_arch=aarch64 ;; \
         *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /usr/local/bin/ttyd \
         "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" \
    && chmod 0755 /usr/local/bin/ttyd \
    && ttyd --version

# herdr keeps agent panes alive in a background server; the Workbench and the
# full-screen terminal are both clients of it. The version and its checksums
# live in the install script, which CI runs too, so the image and the
# end-to-end tests cannot drift onto different herdr releases.
COPY scripts/install-herdr.sh /tmp/install-herdr.sh
RUN sh /tmp/install-herdr.sh /usr/local/bin && rm -f /tmp/install-herdr.sh

# Node, for the agent CLIs and most workspace tooling.
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# An unprivileged user owning everything the sandbox writes to. Matching the
# compose `user: "1000:1000"` means fresh named volumes inherit this ownership.
RUN useradd --uid 1000 --create-home --home-dir /home/coder --shell /bin/bash coder \
    && mkdir -p /workspace /home/coder/.npm-global \
    && chown -R 1000:1000 /workspace /home/coder

# code-server installs to /usr/lib and symlinks into /usr/local/bin.
RUN curl -fsSL https://code-server.dev/install.sh | sh

# Coding agents, installed system-wide as root.
#
# They deliberately do NOT go in /home/coder: a named volume is mounted there at
# runtime, which would shadow them and leave updates stranded on the old volume.
# /usr/local/bin is also on the default PATH, so a login shell (which resets PATH
# from /etc/profile) still finds them.
#
# No '|| true' here: a failed install must fail the build rather than quietly
# producing an image whose entire purpose is missing.
RUN if [ "$INSTALL_AGENTS" = "true" ]; then \
        npm install -g --prefix /usr/local --no-fund --no-audit \
            @anthropic-ai/claude-code \
            @openai/codex \
        && claude --version \
        && codex --version ; \
    fi

# Keep user-installed npm binaries on PATH for login shells too.
RUN printf '%s\n' \
        'export NPM_CONFIG_PREFIX=/home/coder/.npm-global' \
        'export PATH="/home/coder/.npm-global/bin:$PATH"' \
        > /etc/profile.d/agentbox.sh \
    && chmod 0644 /etc/profile.d/agentbox.sh

USER 1000:1000
WORKDIR /workspace

# Best-effort editor integration. code-server resolves extensions through Open
# VSX, which does not always carry vendor-published extensions, so a miss here
# must not fail the build — the CLIs and the terminal remain the primary path.
RUN code-server --install-extension anthropic.claude-code \
    || echo "note: Claude Code editor extension unavailable; use the CLI or /terminal"

# The Workbench, from the build stage above. `npm prune --omit=dev` left the
# workspace's node_modules hoisted at the root, so the bridge's dependencies
# come from there.
COPY --from=web /src/bridge/dist /usr/local/lib/agentbox-workbench/bridge
COPY --from=web /src/node_modules /usr/local/lib/agentbox-workbench/node_modules
COPY --from=web /src/app/dist /usr/local/lib/agentbox-workbench/app

COPY --chown=1000:1000 images/workspace/agentbox-workbench /usr/local/bin/agentbox-workbench
COPY --chown=1000:1000 images/workspace/agentbox-review /usr/local/bin/agentbox-review
COPY --chown=1000:1000 images/workspace/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chown=1000:1000 images/workspace/welcome.md /home/coder/welcome.md

# The Review skill, so an agent discovers the loop without being told. /home is
# a volume at runtime and would shadow anything installed into it, so it is
# staged here and the entrypoint copies it into place on every start.
COPY --chown=1000:1000 images/workspace/skills /usr/local/share/agentbox/skills

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["code-server", "--bind-addr=0.0.0.0:8080", "--auth=none", "/workspace"]
