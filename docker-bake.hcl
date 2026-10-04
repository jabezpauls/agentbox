# The two published images, for `docker buildx bake -f docker-bake.hcl`.
#
#   docker buildx bake -f docker-bake.hcl --print          # what would be built
#   TAG=v1.2.0 docker buildx bake -f docker-bake.hcl --load \
#     --set '*.platform=linux/amd64'                       # one platform, into docker
#
# The release workflow (.github/workflows/release.yml) builds the same images
# for linux/amd64 and linux/arm64 and pushes them to ghcr.io. PREFIX points
# them at another registry, e.g. a local one for trying a release out.

variable "PREFIX" {
  default = "ghcr.io/jabezpauls/agentbox"
}

# The release, e.g. v1.2.0. Baked into both images as AGENTBOX_VERSION.
variable "TAG" {
  default = "dev"
}

group "default" {
  targets = ["workspace", "gate"]
}

target "_common" {
  context   = "."
  platforms = ["linux/amd64", "linux/arm64"]
  args = {
    AGENTBOX_VERSION = TAG
  }
  labels = {
    "org.opencontainers.image.source"   = "https://github.com/jabezpauls/agentbox"
    "org.opencontainers.image.version"  = TAG
    "org.opencontainers.image.licenses" = "MIT"
  }
}

target "workspace" {
  inherits   = ["_common"]
  dockerfile = "images/workspace/Dockerfile"
  # The prebuilt image carries both agents; any other choice is built on the
  # box itself (install.sh --agents).
  args = {
    AGENTS     = "claude,codex"
    NODE_MAJOR = "22"
  }
  tags = ["${PREFIX}-workspace:${TAG}"]
  labels = {
    "org.opencontainers.image.description" = "agentbox sandbox: VS Code, the Workbench, herdr, Claude Code and Codex"
  }
}

target "gate" {
  inherits   = ["_common"]
  dockerfile = "images/gate/Dockerfile"
  tags       = ["${PREFIX}-gate:${TAG}"]
  labels = {
    "org.opencontainers.image.description" = "agentbox gate: sign-in, sessions and routing in front of the sandbox"
  }
}
