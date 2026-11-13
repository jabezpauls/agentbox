# Releasing

Every push to `main` is a release. Nobody picks a version, edits a
`package.json` or pushes a tag: [`.github/workflows/release.yml`](.github/workflows/release.yml)
does it all, in this order:

1. **version.** [`scripts/next-version.sh`](scripts/next-version.sh) names the
   release: the next patch after the highest release tag `vX.Y.Z`, or after
   the version npm calls `latest` for `@jabezpauls/agentbox` if that is higher.
   (Nothing is committed for it. The version is stamped into what gets built:
   the CLI's `package.json` in the npm job, the images' `AGENTBOX_VERSION`,
   the bundle's `VERSION` and `package.json`s, and `install.sh`.)
2. **test.** All of [`ci.yml`](.github/workflows/ci.yml) runs against the
   commit. Nothing is published unless it passes.
3. **images.** Both images are built natively for linux/amd64 and linux/arm64
   and pushed to `ghcr.io/jabezpauls/agentbox-workspace` and
   `ghcr.io/jabezpauls/agentbox-gate`, tagged `vX.Y.Z`, `X.Y`, `latest` and
   `sha-<commit>`.
4. **GitHub release.** The commit is tagged `vX.Y.Z` (through the API with the
   workflow's own token, which starts no further workflow), and the release is
   created with `agentbox.tar.gz` (also as `agentbox-vX.Y.Z.tar.gz`),
   `install.sh` and `SHA256SUMS`, marked latest. That is what
   `releases/latest/download/install.sh` and `agentbox update` fetch. With
   them go the machines' files: the standalone executables
   (`agentbox-linux-x64`, `agentbox-linux-arm64`, `agentbox.exe`, and
   `agentbox-node.exe`, the windowless copy), built by
   [`web/cli/scripts/build-sea.mjs`](web/cli/scripts/build-sea.mjs) and
   started once on each platform first, and `machines-manifest.json` with its
   signature `machines-manifest.json.sig` (below).
5. **npm.** The CLI is published as `@jabezpauls/agentbox` `X.Y.Z` through
   npm's trusted publishing, with provenance.

The box's reported version, the image tag, the bundle and `agentbox --version`
are all `vX.Y.Z`.

A push that changes only documentation (`docs/**` or any `*.md`) is not
released. Pushes are released one at a time; one that arrives while a release
runs waits, and of several waiting only the newest runs (it carries the others'
changes). A commit `main` has already moved past when its run starts is not
released on its own; the next one includes it.

The repository's `web/cli/package.json` and `web/gate/package.json` keep the
version they have (`0.1.0`): it is only what a build outside a release says.
The git tags are the record of what was released.

## A minor or a major release

Run the workflow by hand on `main`, choosing the bump:

```bash
gh workflow run release.yml --ref main -f bump=minor   # 0.4.2 -> 0.5.0
gh workflow run release.yml --ref main -f bump=major   # 0.5.0 -> 1.0.0
```

or Actions → release → Run workflow. It releases the tip of `main` as the new
version, even if that commit was just released as a patch. Later pushes carry
on from there (0.5.1, …).

To see what the next release would be called:

```bash
git fetch --tags && scripts/next-version.sh                 # patch
scripts/next-version.sh --bump minor
```

## Once, before the first automatic release

1. **The default branch is `main`.** Releases run on pushes to `main` only, and
   the docs link to files on `main`. (Settings → General → Default branch;
   pushing the local `master` as `main` first if need be.)
2. **npm trusted publisher.** `@jabezpauls/agentbox` 0.1.0 is already on npm,
   so the package exists. As the `jabezpauls` account on npmjs.com: the package
   → Settings → Trusted Publisher → GitHub Actions, with
   - Organization or user: `jabezpauls`
   - Repository: `agentbox`
   - Workflow filename: `release.yml`
   - Environment: leave empty.

   No token is needed: the npm job signs in with the workflow's OIDC identity
   (`id-token: write`, npm 11.5 or later). Once it works, Settings → Publishing
   access → "Require two-factor authentication and disallow tokens" can be
   turned on. An `NPM_TOKEN` Actions secret, if one exists, is only a fallback
   and can be deleted.
3. **Workflow permissions.** Each job asks for what it needs (`packages:
   write`, `contents: write` to tag and release, `id-token: write`), which
   works with the default "Read repository contents" setting under Settings →
   Actions → General → Workflow permissions. Change it only if an organisation
   policy restricts it, or if the tag step fails with "Resource not accessible
   by integration" (then choose "Read and write permissions").
4. **Make the images public, after the first run.** GHCR creates both packages
   on the first push, private. For each of `agentbox-workspace` and
   `agentbox-gate`: github.com/jabezpauls?tab=packages → the package → Package
   settings → Danger Zone → Change visibility → Public. Check that "Manage
   Actions access" lists the `agentbox` repository with write access (it is
   linked by the image's `org.opencontainers.image.source` label). Until then,
   installs fail at the pull with "could not pull …". Do it once; later
   releases keep the setting.

5. **The machines signing key.** Before the first release with machines in
   it, as [Signing machines releases](#signing-machines-releases) says. Without
   the `MACHINES_SIGNING_KEY` secret every release fails at its `machines` job.

## Signing machines releases

A machine's node updates only from `machines-manifest.json` on the latest
GitHub release, and only if `machines-manifest.json.sig` beside it is an
ed25519 signature of it by a key the node was built with: it never trusts the
box, or a key it learns later. The manifest names, per platform, the node's
executable, herdr and Claude Code, each by URL and SHA-256
([`web/cli/scripts/machines-manifest.mjs`](web/cli/scripts/machines-manifest.mjs)
writes and signs it; Claude Code's pinned version and digests live there, and
herdr's Linux pins come from `scripts/install-herdr.sh`).

The private key lives only in the repository secret `MACHINES_SIGNING_KEY`
(and an offline copy you keep). The node carries the public keys in
[`web/cli/src/node/release-keys.ts`](web/cli/src/node/release-keys.ts):
`RELEASE_PUBLIC_KEYS`, at most two, the current key and the next one. With
the list empty the node refuses every update, and says why.

### Making the keys, once

On a machine you trust, not in CI:

```bash
umask 077
openssl genpkey -algorithm ed25519 -out machines-current.pem   # PKCS#8 PEM
openssl genpkey -algorithm ed25519 -out machines-next.pem
openssl pkey -in machines-current.pem -pubout                   # its public key
openssl pkey -in machines-next.pem -pubout
gh secret set MACHINES_SIGNING_KEY --repo jabezpauls/agentbox < machines-current.pem
```

Put both public keys (each `-----BEGIN PUBLIC KEY-----` … `-----END PUBLIC
KEY-----` block, whole) into `RELEASE_PUBLIC_KEYS`, current first, and merge
that before (or with) the first release machines should update from. Keep
both private keys offline (a password manager, or encrypted:
`openssl pkey -in machines-next.pem -aes256 -out machines-next.enc.pem`), and
delete the plain files. Once the list has keys, the release's `machines` job checks the secret signs
with one of the built-in keys, and fails if not.

### Rotating

Because every node already trusts the next key:

1. Make a new "next after next" key pair.
2. Set the secret to the **next** key: `gh secret set MACHINES_SIGNING_KEY
   --repo jabezpauls/agentbox < machines-next.pem`.
3. In `RELEASE_PUBLIC_KEYS`, drop the old current key, so the list is the
   next key (now current) and the new one (now next). Merge: that release is
   signed with the key every node trusts, and the nodes it updates carry the
   new list.

Machines that skip that release still trust the key it was signed with, so
they keep updating. If the current key leaks, rotate at once the same way; a
node that has not updated since still trusts the leaked key, so say so in the
release notes. If both keys leak, nodes must be reinstalled by hand from a
release with new keys.

## Trying a release locally

Build its files and look at its images without publishing anything:

```bash
scripts/build-release.sh v1.2.0 dist/release     # bundle, install.sh, SHA256SUMS
TAG=v1.2.0 docker buildx bake -f docker-bake.hcl --print
(cd web && AGENTBOX_VERSION=v1.2.0 npm run build:sea -w cli)   # web/cli/dist/sea
```

and install from them with `AGENTBOX_RELEASE_URL` (a folder laid out as
`download/<tag>/…` and `latest/download/…`, served over http or as `file://`)
and `AGENTBOX_IMAGE_PREFIX` (a registry holding the images). That is what
`tests/install/release.sh` does without Docker. `tests/install/next-version.sh`
checks how versions are chosen.

## If a release goes wrong

- **Re-run the failed jobs** (or the whole run). A re-run of a commit keeps
  the version it was given: whatever already exists is left alone and the
  rest is finished — images already pushed for this commit are not rebuilt,
  an existing tag or GitHub release is kept, and a version already on npm is
  not published again.
- **Or push a fix.** The next push is released as the next version. A version
  whose run failed before the tag step was never tagged, so the fix may get
  the same number; one that was tagged is skipped over.
- npm versions cannot be reused. If a bad version reached npm, deprecate it
  (`npm deprecate @jabezpauls/agentbox@1.2.0 "…"`) and push a fix. A bad
  GitHub release can be deleted (`gh release delete v1.2.0`); keep its tag, so
  the number is not handed out again.
- To release nothing for a while, disable the workflow (Actions → release →
  ⋯ → Disable workflow) and enable it again later.
