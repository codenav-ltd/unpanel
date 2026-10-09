# Release Process

> Related: [design/09](../design/09-deployment.md) (artifacts and upgrades), [security-checklist.md](./security-checklist.md).

This page describes the current pre-alpha workflow. Signing, bundled Node runtimes and the broader platform/upgrade matrix are future release-readiness work, not properties of today's packages.

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
| `stable` | Final releases | Stable installs; pre-release installs also accept a newer stable |
| `beta` | Pre-releases, including `-alpha` | Existing pre-release installs |

The update check reads `channels.json` from the site and GitHub, chooses a newer compatible channel release and selects the running architecture's package. Metadata includes SHA-256 hashes, structured change notes, manual-review requirements, known issues, downgrade compatibility and affected-version security advisories. The website deploy merges up to 50 prior releases into the canonical catalog; GitHub remains a fallback mirror and an older single-release manifest remains readable. There is no signature file or enforced minimum direct-upgrade version yet.

Before tagging, review `releases/release-policy.json`. Keep downgrade disabled unless the installed release's database and stored-data changes are readable by every version at or above the declared `minVersion`. Additive schema changes are candidates; dropped/renamed columns and changed data semantics normally require downgrade to remain disabled. Add target-specific known issues here as structured entries. Never enable application downgrade merely because the updater can restore the previous binary after a failed start—those are separate guarantees.

Alpha.33 declares compatibility back to alpha.29. The stored-data code was reviewed against all four intervening release tags, and each tag's implementation was tested against a database populated by the current implementation: owner TOTP login, read-only demo restrictions, encrypted email and Turnstile settings, and the active TLS certificate remained readable. Repeat the audit before extending this range or retaining it after a data migration. This declaration belongs to alpha.33; alpha.30–alpha.32 retain their original disabled policies, so installations on those versions must first upgrade to alpha.33 to use its downgrade range. Downgrades still require explicit review and can restore bugs fixed by later versions.

### Project endpoints

For updates starting with alpha.34, unchanged service configuration uses a shorter restart path. Releases that change service units, environment or runtime paths still run the installer. Validate both paths and failed-start/wrong-version rollback with `node scripts/check-panel-swap.mjs` on Linux; CI runs this fixture with isolated directories and mocked host commands. Keep real systemd timing measurements separate from this functional fixture. In an isolated WSL Linux/systemd benchmark using three runs per path, the old flow took 938–947 ms of downtime, the initial upgrade through an older updater took 369–388 ms, and the new swap path took 302–366 ms. These measurements exclude download time and do not predict another server's boot speed.

| URL | Contents |
|---|---|
| `https://unpanel.codenav.dev/install.sh` | Panel installer. It downloads the linux-x64 or linux-arm64 package for the pinned version and checks `SHA256SUMS`. |
| `https://unpanel.codenav.dev/install-agent.sh` | Agent installer for a machine that does not run the panel. Same package, agent only. |
| `https://unpanel.codenav.dev/channels.json` | Update manifest for Settings → Updates. CI also uploads this file to the GitHub release. Minisign is not produced yet. |
| `https://github.com/codenav-ltd/unpanel/releases` | Release artifacts, `SHA256SUMS`, `channels.json` |

- **Moving domains.** Installed panels keep the manifest URL they shipped with. If the domain changes, keep the old one serving or redirecting `channels.json` for at least one major version. The release that switches the default URL must ship while the old URL still works.
- **Trust.** HTTPS protects transport and SHA-256 detects mismatched package bytes. Cryptographic publisher authentication is not implemented. Treat a compromised publishing account or manifest host as an update-trust compromise. Unattended updates require an asset in this project's versioned GitHub release; signing remains planned below.

### Security advisories

Maintain `releases/security-advisories.json` as a cumulative registry of actual advisories. Packaging validates it and places it in `channels.json`. Severity, affected ranges, fixed version, mitigation and deadlines control warnings separately from changelog categories. High/critical notices reuse configured Alert channels; critical dialogs repeat hourly. Owners can opt into critical updates after a grace period, with persisted retry limits and maintenance/manual-review holds. See [the complete policy and publisher workflow](./security-updates.md). Leave the registry empty when no real advisory is being published.

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
| `unpanel-<ver>-linux-<arch>.tar.gz` | x64, arm64 | `ubuntu-latest` x64 runner; arm64 uses the same JS bundle and matching native Argon2 dependency |
| `SHA256SUMS`, `channels.json` | Shared | Produced from the exact packages |

Both panel and agent are in each package. Node.js 24 must already be installed; it is not bundled. `.github/workflows/ci.yml` runs lint (including SPDX/license/format checks), typechecks, tests and website-deployment script checks. `.github/workflows/release.yml` separately installs with the frozen lockfile, builds the web UI, bundles, packs and publishes. Only tag the exact commit after its CI succeeds: the release workflow does not rerun the full CI job.

Packages contain the built panel/agent/management scripts, frontend, native password-hashing dependency, installers/update helpers, `LICENSE`, `VERSION` and `SOURCE` naming the exact tag. Packaging verifies the native dependency and architecture metadata. The CI license check rejects disallowed licenses. A bundled-runtime license inventory, native arm64 execution tests and the complete Linux VM installation/upgrade matrix remain release-readiness work.

## 4. Signing (planned)

- Planned release key: Ed25519 with minisign; a future implementation must embed and publish the verification key before enforcing signed upgrades. No release verification key is currently shipped.
- Planned private-key storage: offline or protected CI secrets with release review.
- Planned signed files: `SHA256SUMS` and `channels.json`.
- Planned rotation: announce the new key in a release signed by the old key and keep an overlap period.

## 5. Steps

1. Finish the requested changes and appropriate automated/browser validation. Review the diff, excluding credentials, local data and internal handover logs. Record platform or external-service checks that were not run.
2. Update `CHANGELOG.md` under the version/date. Packaging maps `Added`, `Changed`, `Fixed`, `Security`, `Critical`, `Deprecated`, and `Removed` to release rows. `Removed` marks manual review and blocks unattended installation. Use a real advisory registry entry separately for a vulnerability.
3. Bump `packages/shared/src/product.ts`, both installer pins, the protocol test-vector version, API version assertion, README status and deployment-document status. Update relevant feature/runbook docs.
4. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, the web production build and `node scripts/bundle.mjs`. Registry schema tests run with the suite. Packaging runs on Linux x64 in CI.
5. Commit and push `main`. Wait for **CI on that exact SHA** to pass. Then create and push `v<version>` pointing to that SHA. Tag creation publishes a prerelease automatically; it is not a draft or a deployment to users' panels.
6. Wait for Release packaging and its reusable website deployment to succeed. Verify the release version, four assets, package/manifest SHA-256 values, `channels.json` version/registry and public installer pins. Do not claim the website is deployed merely because GitHub assets exist.
7. Report the release link and actual validation. For a security fix, coordinate public disclosure under `SECURITY.md` and verify affected-version notices. Test clean installation and upgrades on the supported Linux VM matrix before claiming that matrix is validated.

## 6. Compatibility matrix (v1 target)

The broader v1 target below is not the currently validated platform matrix. Current pre-alpha agent compatibility and rollback behavior are documented in [design/09](../design/09-deployment.md).

| Panel | Agents supported | Upgrade from |
|---|---|---|
| 1.x | protocol 1.x | any 1.x |

Rule: panel N supports agents on the current and previous protocol major. Upgrading across more than one major requires stepping through each major.

## 7. Hotfixes

- Fix on a branch, add a relevant regression test, and follow the checked-commit release procedure above.
- If maintaining an older release line, forward-port the fix to `main` as part of that work.
- Security fixes follow `SECURITY.md` (private fix, coordinated disclosure).
