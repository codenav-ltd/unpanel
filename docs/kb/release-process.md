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
