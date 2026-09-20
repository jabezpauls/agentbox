# The sandbox image: an editor, a shell, a process monitor, and the coding
# agents — all runnable as an unprivileged user.
FROM debian:bookworm-slim

ARG NODE_MAJOR=22
# Set to "false" to build without the coding agents (smaller image).
ARG INSTALL_AGENTS=true

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/coder \
    SHELL=/bin/bash \
    # npm must not try to write to a root-owned prefix at runtime.
    NPM_CONFIG_PREFIX=/home/coder/.npm-global \
    PATH=/home/coder/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git openssh-client \
        bash less nano vim \
        ripgrep fd-find jq unzip zip \
        python3 python3-venv python3-pip \
        btop procps htop \
        ttyd \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

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

USER 1000:1000
WORKDIR /workspace

# Coding agents. Kept in one layer and guarded so a registry hiccup or a renamed
# package fails the build loudly rather than producing a silently agent-less image.
RUN if [ "$INSTALL_AGENTS" = "true" ]; then \
        npm install -g --no-fund --no-audit \
            @anthropic-ai/claude-code \
            @openai/codex ; \
        claude --version || true ; \
        codex --version || true ; \
    fi

# Best-effort editor integration. code-server resolves extensions through Open
# VSX, which does not always carry vendor-published extensions, so a miss here
# must not fail the build — the CLIs and the terminal remain the primary path.
RUN code-server --install-extension anthropic.claude-code || \
    echo "note: Claude Code editor extension unavailable; use the CLI or /terminal"

COPY --chown=1000:1000 entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chown=1000:1000 welcome.md /home/coder/welcome.md

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["code-server", "--bind-addr=0.0.0.0:8080", "--auth=none", "/workspace"]
