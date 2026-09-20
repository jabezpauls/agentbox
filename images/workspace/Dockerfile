# The sandbox image: an editor, a shell, a process monitor, and the coding
# agents — all runnable as an unprivileged user.
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
        build-essential \
    && rm -rf /var/lib/apt/lists/*

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

COPY --chown=1000:1000 entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chown=1000:1000 welcome.md /home/coder/welcome.md

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["code-server", "--bind-addr=0.0.0.0:8080", "--auth=none", "/workspace"]
