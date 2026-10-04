# Releasing

A release is a tag, `vX.Y.Z`. Pushing one runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which:

1. runs all of CI against the tag;
2. builds both images for linux/amd64 and linux/arm64 and pushes them to
   `ghcr.io/jabezpauls/agentbox-workspace` and `ghcr.io/jabezpauls/agentbox-gate`,
   tagged `vX.Y.Z`, `X.Y` and `latest`;
3. creates the GitHub release with `agentbox.tar.gz` (also as
   `agentbox-vX.Y.Z.tar.gz`), `install.sh` and `SHA256SUMS`;
4. publishes the CLI to npm as `@jabezpauls/agentbox`, version `X.Y.Z`, with
   provenance.

A tag with a suffix, such as `v1.2.0-rc.1`, is a pre-release: its images get
only their own tag, the GitHub release is marked pre-release (so
`releases/latest` still points at the last full release), and npm gets it
under the `next` dist-tag.

## Once, before the first release

1. **The default branch is `main`.** CI runs on pushes to `main`, and the docs
   link to files on `main`.
2. **An npm token.** On npmjs.com, as the `jabezpauls` account, create a
   granular access token that can publish `@jabezpauls/agentbox` (or an
   automation token). Add it to the repository as the Actions secret
   `NPM_TOKEN` (Settings → Secrets and variables → Actions). The scope
   `@jabezpauls` is the account's own, so nothing needs creating on npm first.
3. **Workflow permissions.** Settings → Actions → General → Workflow
   permissions: the workflow asks for what it needs per job
   (`packages: write`, `contents: write`, `id-token: write`), which works with
   the default "Read repository contents" setting. Nothing to change unless an
   organisation policy restricts it.
4. **Make the images public, after the first release.** GHCR creates both
   packages on the first push, private. For each of `agentbox-workspace` and
   `agentbox-gate`: github.com/jabezpauls?tab=packages → the package →
   Package settings → Danger Zone → Change visibility → Public. Check that
   "Manage Actions access" lists the `agentbox` repository with write access
   (it is linked by the image's `org.opencontainers.image.source` label).
   Until then, installs fail at the pull with "could not pull …". Do it once;
   later releases keep the setting.

## Cutting a release

```bash
git checkout main && git pull
scripts/release.sh 1.2.0          # sets the versions, commits "Release v1.2.0", tags v1.2.0
git push origin main v1.2.0       # starts the release workflow
```

`scripts/release.sh` sets the version in `web/cli/package.json` (the npm
package) and `web/gate/package.json` (what the box reports), updates the
lockfile, commits and makes an annotated tag. It pushes nothing. The workflow
refuses a tag whose version does not match those two files.

To try a release before tagging, build its files and images locally:

```bash
scripts/build-release.sh v1.2.0 dist/release     # bundle, install.sh, SHA256SUMS
TAG=v1.2.0 docker buildx bake -f docker-bake.hcl --print
```

and install from them with `AGENTBOX_RELEASE_URL` (a folder laid out as
`download/<tag>/…` and `latest/download/…`, served over http or as `file://`)
and `AGENTBOX_IMAGE_PREFIX` (a registry holding the images). That is what
`tests/install/release.sh` does without Docker.

## If a release goes wrong

- A failed workflow before the GitHub release step has published nothing that
  installs use: fix, delete the tag (`git push origin :v1.2.0`, `git tag -d
  v1.2.0`) and tag again. Images already pushed under `vX.Y.Z` are overwritten
  by the next run.
- npm versions cannot be reused. If the npm step fails after the GitHub release
  exists, re-run just that job. If a bad version reached npm, deprecate it
  (`npm deprecate @jabezpauls/agentbox@1.2.0 "…"`) and release the next patch.
