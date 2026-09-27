# The gate: agentbox's front door. Sign-in, sessions, two-factor, device tokens
# and the routing of every request.
#
# Deliberately not part of the sandbox image: whatever decides who gets in must
# live where no agent can change it. So it is its own small image — Node and the
# compiled gate, nothing else — run as its own user (not the sandbox's 1000),
# with its own volume and a read-only root filesystem.
#
# Built from the repository root (see docker-compose.yml), like the sandbox
# image, so the web workspace and its lockfile are in the context.

FROM node:22-bookworm-slim AS build
WORKDIR /src
# Every workspace's manifest, so `npm ci` can check the lockfile against them.
COPY web/package.json web/package-lock.json ./
COPY web/shared/package.json shared/
COPY web/bridge/package.json bridge/
COPY web/app/package.json app/
COPY web/gate/package.json gate/
COPY web/vscode-ext/package.json vscode-ext/
COPY web/cli/package.json cli/
RUN npm ci
COPY web/ .
RUN npm run build -w gate
# The CLI the gate serves at /cli/, stamped with this box's version, which is
# what /_gate/version reports and the CLI compares itself with. Declared only
# here, so a new version rebuilds just this step.
ARG AGENTBOX_VERSION=dev
RUN npm run build -w cli

# The gate's production dependencies alone, installed from the lockfile on the
# same base as the runtime, so the native bcrypt binding matches its libc.
FROM node:22-alpine AS deps
WORKDIR /src
COPY web/package.json web/package-lock.json ./
COPY web/shared/package.json shared/
COPY web/bridge/package.json bridge/
COPY web/app/package.json app/
COPY web/gate/package.json gate/
COPY web/vscode-ext/package.json vscode-ext/
COPY web/cli/package.json cli/
RUN npm ci --omit=dev --workspace gate

FROM node:22-alpine
ENV NODE_ENV=production \
    GATE_DATA_DIR=/data

# Its own user, distinct from the sandbox's uid 1000. /data is created here and
# owned by it so a fresh named volume inherits that ownership.
RUN addgroup -g 10001 gate \
    && adduser -u 10001 -G gate -H -h /nonexistent -s /sbin/nologin -D gate \
    && mkdir -p /data \
    && chown 10001:10001 /data \
    && chmod 0700 /data

WORKDIR /app
COPY --from=deps /src/node_modules /app/node_modules
COPY --from=build /src/gate/package.json /app/package.json
COPY --from=build /src/gate/dist /app/dist
# /cli/agentbox.mjs and /cli/install (the gate writes the box's URL into the
# script as it serves it).
COPY --from=build /src/cli/dist/agentbox.mjs /app/cli/agentbox.mjs
COPY --from=build /src/cli/install.sh /app/cli/install
COPY images/gate/agentbox-gate /usr/local/bin/agentbox-gate

# Last, so a new version rebuilds only this layer.
ARG AGENTBOX_VERSION=dev
ENV AGENTBOX_VERSION=${AGENTBOX_VERSION}

USER 10001:10001
VOLUME /data
EXPOSE 7900
CMD ["node", "/app/dist/main.js"]
