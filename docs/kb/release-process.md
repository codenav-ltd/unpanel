# Release Process

> Related: [design/09](../design/09-deployment.md) (artifacts and upgrades), [security-checklist.md](./security-checklist.md).

## 1. Versioning

- [Semantic Versioning](https://semver.org/). Panel and agent share one version number and are released together.
- `MAJOR`: breaking changes to the HTTP API (`/api/v2`), the agent protocol major, the config file format, or removal of features.
- `MINOR`: features, additive protocol changes, new migrations.
- `PATCH`: fixes only; no migrations except emergency fixes.
- Pre-releases: `1.4.0-beta.1`, `1.4.0-rc.1`.
- Protocol version (`proto`) is independent of the product version and documented in [design/02](../design/02-agent-protocol.md) §9.

## 2. Channels

| Channel | Contents | Who gets it |
|---|---|---|
| `stable` | Final releases | Default for online upgrades |
| `beta` | `-beta` / `-rc` pre-releases | Opt-in in Settings → Updates |

The update check reads a signed manifest (`channels.json` + `channels.json.minisig`) listing the latest version per channel and the minimum version that can upgrade directly.

### Project endpoints

| URL | Contents |
|---|---|
| `https://unpanel.codenav.dev/install.sh` | Panel installer. It downloads the linux-x64 or linux-arm64 package for the pinned version and checks `SHA256SUMS`. |
| `https://unpanel.codenav.dev/install-agent.sh` | Agent installer for a machine that does not run the panel. Same package, agent only. |
| `https://unpanel.codenav.dev/channels.json` | Update manifest for Settings → Updates. CI also uploads this file to the GitHub release. Minisign is not produced yet. |
| `https://github.com/codenav-ltd/unpanel/releases` | Release artifacts, `SHA256SUMS`, `SHA256SUMS.minisig` |

- **Moving domains.** Installed panels keep the manifest URL they shipped with. If the domain changes, keep the old one serving or redirecting `channels.json` for at least one major version. The release that switches the default URL must ship while the old URL still works.
- **Trust.** The manifest's minisign signature, not TLS, is the trust anchor. A compromised web host can withhold updates but cannot push a malicious one to existing installs.

### Automated website deployment

`.github/workflows/release.yml` calls the reusable `deploy-site.yml` workflow after the release assets are uploaded. This is a direct workflow call: it does not depend on a `release` event, which a release created by `GITHUB_TOKEN` would not trigger in another workflow.

Configure the GitHub `website` environment once:

- Variables: `SITE_SSH_HOST`, `SITE_SSH_USER`; optional `SITE_SSH_PORT` (default `22`), `SITE_PATH` (default `/web/unpanel`), and `SITE_URL` (default `https://unpanel.codenav.dev`).
- Secrets: `SITE_SSH_KEY`, a dedicated deployment private key, and `SITE_SSH_KNOWN_HOSTS`, the verified SSH host-key entry. Host-key checking stays enabled. Never put these credentials in the repository.
- The SSH user needs write access to the existing static website and its parent directory. The server needs Bash, curl, tar, sha256sum, realpath, and flock. Deployment does not use sudo or restart the panel.
- Allow release tags to use the environment. Leave required reviewers disabled if deployments should run without manual approval; GitHub environment protection rules still apply.

The workflow checks out the requested tag, builds `@unpanel/site`, downloads that published release's `channels.json` and `SHA256SUMS`, and checks the manifest hash and installer version pins. It packages the website, both installers, and manifest together. SSH credentials exist only in a private temporary directory on the runner and are removed on exit.

Deployments are serialized. A version check rejects an older release and the host takes a lock and checks that the current version has not changed. Files are extracted and verified before the existing website is moved aside. The directory replacement can cause a brief interruption; no web-server configuration changes are needed. Every public file is then downloaded through the normal site URL and compared with its expected SHA-256. Failure restores the previous directory and fails the workflow; a successful deployment retains a backup at `<SITE_PATH>.previous.<id>`. Remove old backups separately when they are no longer needed.

To repair a missed deployment without rebuilding or replacing release packages, run **Actions → Deploy website → Run workflow** from `main`, with the existing release tag (for example `v0.1.0-alpha.19`). This also deploys tags created before the automatic website job existed. A GitHub Release can remain available even if website deployment fails; rerun the deployment, and do not equate the uploaded release with a successful website deployment.

The website must serve ordinary static files without rewriting their contents. Keep `install.sh`, `install-agent.sh`, `channels.json`, and `VERSION` uncached (`Cache-Control: no-store`). SHA-256 verification of public responses detects stale caching instead of reporting success.

## 3. Build matrix

| Artifact | Architectures | Build environment |
|---|---|---|
| `unpanel-<ver>-linux-<arch>.tar.xz` | x64, arm64 | Debian 11 (glibc 2.31) containers in CI; arm64 built natively on arm64 runners |
| `unpanel-agent-<ver>-linux-<arch>.tar.xz` | x64, arm64 | Same |

Each build: install with the frozen lockfile → typecheck → test → bundle → fetch the pinned Node runtime (verifying its official `SHASUMS256.txt` signature) → strip → compile native modules → smoke test (`node main.js --version`, open the DB, load native modules) → pack.

Every tarball contains `LICENSE` (AGPL-3.0), `THIRD_PARTY_NOTICES` (generated from the production dependency tree, including the bundled Node.js runtime's license), and a `SOURCE` file naming the exact git tag. The build embeds the tag URL as the default `about.source_url` ([ADR-0011](../adr/0011-agpl-license.md)). The CI license check fails the build if a disallowed license appears ([conventions.md](./conventions.md) §10).

## 4. Signing

- Release key: Ed25519, used with [minisign](https://jedisct1.github.io/minisign/). The public key is embedded in the panel and agent (for online upgrade verification) and published in `SECURITY.md` and the README.
- The private key lives offline or in the CI secret store with required reviewers on the release environment; never on developer machines.
- Signed files: `SHA256SUMS` (covering every artifact and installer), `channels.json`.
- Key rotation: a new key is announced in a release signed by the old key, and both keys are trusted for one minor release.

## 5. Steps

1. Create a release branch `release/<major>.<minor>` for minor/major releases (patches are cherry-picked onto it).
2. Run the [security checklist](./security-checklist.md) and the manual checklist in [design/10](../design/10-testing.md) §5.
3. Update `CHANGELOG.md`: move "Unreleased" entries under the new version with the date. Packaging maps `Added`, `Changed`, `Fixed`, `Security`, `Critical`, `Deprecated`, and `Removed` headings to structured rows in `channels.json` and to the GitHub Release body. Use `Removed` only when existing behavior is no longer available; it marks the release for manual review and prevents unattended automatic installation.
4. Bump versions (`pnpm -r version` via a script) and tag `v<version>` (signed tag).
5. CI builds, signs, and drafts the GitHub Release with artifacts, `SHA256SUMS`, `SHA256SUMS.minisig`, installers.
6. Verify the draft: download on a clean VM, verify checksums and signature, run the installer, upgrade from the previous stable.
7. Publish the release, then update `channels.json` (stable or beta).
8. Announce (release notes link). For security releases, publish the advisory at the same time.

## 6. Compatibility matrix

Maintained in the README and release notes:

| Panel | Agents supported | Upgrade from |
|---|---|---|
| 1.x | protocol 1.x | any 1.x |

Rule: panel N supports agents on the current and previous protocol major. Upgrading across more than one major requires stepping through each major.

## 7. Hotfixes

- Branch from the release branch, fix, add a test, release as a patch.
- Forward-port the fix to `main` in the same day.
- Security fixes follow `SECURITY.md` (private fix, coordinated disclosure).
