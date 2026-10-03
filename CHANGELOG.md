# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-alpha.29] - 2026-10-03

### Added

- Expand `unpanel-manage` with service status/start/stop/restart, bounded or following logs, update checks and installation, security status, account listing, targeted IP unban, Turnstile recovery, private password reset and confirmed 2FA reset.
- Recovery changes revoke affected sessions and pending challenges, preserve account access settings, and commit their audit record atomically. Database access uses the installed data directory and drops to the service account to preserve SQLite ownership.

### Fixed

- Privileged terminal commands now check administrator access first and suggest the exact `sudo` command instead of throwing filesystem exceptions. Missing databases are refused without creating an empty replacement.
- Keep the audit chain valid across panel and terminal writers and transaction rollbacks.
- Turnstile setup uses correctly aligned controls, normal or compact challenge sizes, clear expired/error states and retry controls. Render after the script's load event without calling the `ready()` helper that rejects async/defer scripts. Old widget callbacks cannot alter a newer challenge; failed server tests remain visible during retries.
- Keep Node installation checksum output out of the returned executable path; reject invalid runtime paths and stop on failed installation or copying.

### Changed

- Terminal updates honor releases requiring review and require approval of the exact available version. Documentation separates available recovery commands from planned runbooks.
- Enabling or replacing Turnstile keys requires a successful setup test bound to the current session and configuration. Setup verifies its own action and hostname; its short-lived authorization expires after five minutes and is consumed on save.

## [0.1.0-alpha.28] - 2026-10-03

### Fixed

- Restore readable spacing between settings descriptions, status labels and actions, including security update policy, Turnstile, password changes, authentication methods and recovery codes. Mobile settings keep the selected tab visible and show complete release versions.
- Loading indicators now render as visible rings in text as well as buttons. More async actions show their own pending state, while account, email and user settings distinguish loading, empty, success and failure states.
- Refreshing an authenticated panel uses a neutral session-loading screen instead of briefly displaying a login card. Startup reuses one session check, offers a retry on connection errors and restores the last theme before mounting.
- Render the Turnstile challenge and remaining-attempt warnings on the sign-in form, where they are required, instead of the first-run setup form.
- Dialogs opened on mount now enter the native modal layer correctly. Dropdowns stay within the viewport and dialog boundaries; keyboard navigation, nested-dialog focus restoration and mobile sidebar focus handling are improved.

### Changed

- Page navigation, settings sections, setup steps and dialogs use shared short transitions and honor reduced-motion preferences. Live polling does not restart page animations. These changes add no UI framework or runtime dependency.

## [0.1.0-alpha.27] - 2026-10-03

### Fixed

- Give panel outbound address attempts two seconds to connect, fixing Telegram setup failures on slower working IPv4 routes when another resolved address is unreachable. Explicit Node timeout settings remain authoritative; dual-stack selection, TLS verification and overall request deadlines are preserved.
- Telegram setup now distinguishes DNS, connection, TLS and invalid-response failures without claiming that a notification may have been sent. Safe error codes identify network problems without exposing bot tokens. Provider HTTP errors and cooldowns remain available even when a gateway responds with HTML.

## [0.1.0-alpha.26] - 2026-10-03

### Added

- Version-scoped security advisories support four severity levels, affected ranges, fixed versions, mitigation guidance and publisher deadlines. Critical advisories show a persistent red notice and an hourly reminder dialog; high and critical advisories can reuse enabled Telegram and email Alert channels.
- Owners can authorize critical fixes after a 6, 24 or 72-hour grace period through a reviewed, reauthenticated policy. Maintenance, incompatible packages, manual-review releases, failed metadata checks and bounded retry limits prevent unattended installation; notify-only remains the default.

### Changed

- Update checks share a bounded cache, preserve known security warnings during outages and persist notification and retry limits across restarts. Manual installation confirms the reviewed target version. Security notices and policy controls load on demand.
- Release documentation now distinguishes shipped HTTPS/checksum verification from planned cryptographic release signing, and documents the cumulative advisory registry without declaring synthetic vulnerabilities.

## [0.1.0-alpha.25] - 2026-10-03

### Added

- Owner-verified user management with single-user/team modes, four built-in roles, explicit node scopes, account disable/delete and password reset. Switching to single-user mode atomically revokes every other user's access without losing their permissions.
- Read-only demo accounts protect both infrastructure and account credentials. Assigned monitoring remains accessible while writes, provider configuration, global logs and backups are denied by the API.

### Security

- Central authorization checks protect node routes and global modules, filter node lists, enforce same-origin writes and revoke sessions on access changes. Older binaries reject non-owner logins and sessions instead of granting accidental administrative access.

### Fixed

- Large overview cards now fit narrow screens; read-only access labels stay separate from navigation controls.

## [0.1.0-alpha.24] - 2026-10-03

### Changed

- Email alert destinations now select a named delivery method from Settings → Email. SMTP/API credentials are configured once and can be reused by Alerts and email OTP. Existing alert credentials migrate automatically without changing channel IDs, routing or queued deliveries.
- Shared email methods show their linked-use count and cannot be disabled or removed while still referenced. Provider changes are resolved when a notification is delivered, so credentials do not need copying into every consumer.
- Alert rules start with useful names, thresholds and duration presets. The default editor focuses on conditions and destinations; node targeting, severity, recovery and reminders are under Advanced options. Choosing specific nodes or channels requires an explicit nonempty selection.

## [0.1.0-alpha.23] - 2026-10-03

### Added

- Security now manages named TOTP, passkey and verified email OTP methods, with a configurable per-account requirement and allowed method types. Users can add, rename, replace and remove methods through guided dialogs.
- Sign-in offers a choice of allowed methods and single-use recovery codes. TOTP setup includes a QR code; initial enrollment helps users save recovery codes. Account-security changes require recent password and, when required, second-factor verification.
- Settings → Email stores named SMTP, Resend and Postmark delivery methods for email OTP. Credentials are encrypted, test delivery is available, and referenced methods cannot be removed or disabled. Alert migration to shared methods follows in the next release.

### Security

- Existing TOTP accounts retain replay protection and required verification on upgrade. Removing the last allowed method is blocked; policy and credential changes end other sessions and pending sign-ins.
- Email and passkey challenges are short-lived, single-use and bound to their account and purpose. Email sends and verification attempts are bounded. Passkey verification checks the signature, origin, RP ID, counter and user verification; changing the panel origin is blocked while passkeys exist.
- Managed 2FA accounts fail closed in older binaries instead of falling back to password-only sign-in. Deliberate downgrades require a matching pre-upgrade database and master key; see the account-security runbook.

## [0.1.0-alpha.22] - 2026-10-03

### Changed

- Password changes use a three-step dialog with confirmation of the new password and a clear explanation of which sessions will end.
- Cloudflare Turnstile setup guides administrators through connecting a widget, verifying a real browser challenge on the server, and reviewing the change before saving. Failed script loads can be retried.
- Panel access settings link directly to certificate management beside the public address, replacing the empty HTTPS section.

### Fixed

- Waiting for the panel to restart after an update uses the standard loading spinner instead of rotating the cloud update icon.

## [0.1.0-alpha.21] - 2026-10-03

### Fixed

- Background refresh preserves unsaved host settings and ignores responses for a previously selected node or history window. Overview shows stale-data failures with a retry action, and node menu actions report lost replies.
- Backups exported by the panel can be restored through the HTTP server up to the documented 64 MiB limit. Anonymous uploads are rejected before buffering; oversized requests return a readable error.
- Missed agent heartbeats and unanswered monitoring requests no longer leave nodes permanently online or sampling stuck. Replacing a connection clears old requests and ignores late replies from the replaced socket.
- Manual certificate renewal preserves a disabled automatic-renewal setting. A stale certificate reload cannot overwrite a newly started issuance job or stop its progress polling.
- Dialogs expose their visible title to assistive technology. Closed mobile menus and collapsed node lists no longer receive keyboard focus, and malformed client-side routes recover safely.

### Changed

- Metric retention uses a time index and prunes at most once per minute instead of scanning all retained history after every node sample. A repeatable million-row benchmark is included without claiming unmeasured Linux fleet budgets.
- Documentation clarifies current features, validation and runtime requirements separately from the v1 roadmap, with alert API, provider/setup lifecycle, retention benchmark and backup scope details.

### Security

- Password changes revoke other sessions and pending MFA sign-ins atomically while keeping the caller signed in. Concurrent changes cannot overwrite a newer password, and an in-flight old-password login cannot create a fresh session afterward.

## [0.1.0-alpha.20] - 2026-10-03

### Added

- Alerts now watches CPU, memory, system disk, swap, offline nodes and active panel certificate expiry, with configurable rules, persistent incidents, recovery notifications, acknowledgement, reminders and timed incident silences.
- Notification channels can be enabled independently and selected per rule. Email supports verified SMTP with provider presets, Resend API and Postmark API, with encrypted credentials, send tests and visible delivery results.
- Telegram setup guides users from a BotFather token to a one-time message, displays the detected user or group for confirmation, and saves the chat ID automatically after approval.
- A bounded SQLite notification queue preserves pending deliveries across restart, retries temporary provider failures, respects cooldowns and keeps a delivery log.

### Fixed

- Background monitoring now requests metrics even with every browser closed. Stale or missing readings cannot falsely resolve an incident, and maintenance mode suppresses notifications without erasing incident history.
- Connecting the first eligible channel notifies existing active incidents. Rule edits, recovery, silences and channel disabling cancel obsolete queued messages; provider cooldowns survive restart.
- Telegram channels can be edited or reconnected without breaking rule selections, and closing or leaving a setup guide releases its temporary session.

### Security

- Telegram setup is owner-bound, expires after ten minutes, ignores unrelated messages and never removes another application's webhook. Notification credentials and credential-bearing provider responses are not returned to the browser or audit log.

## [0.1.0-alpha.19] - 2026-10-03

### Added

- Certificates can generate a self-signed certificate, import a PEM chain and matching key, or request a Let's Encrypt production or staging certificate through HTTP-01. The panel stores private keys encrypted and renews ACME certificates automatically with retry backoff.
- Applying a certificate enables real HTTPS and WSS on the existing panel port, verifies the served certificate locally, and saves the domain or IP address. Self-signed node enrollment commands include the public certificate needed for TLS verification.
- Available panel updates now have a structured release-details dialog with one row per new feature, improvement, bug fix, security item, critical item, deprecation, or breaking change.
- Release packaging derives update details and the GitHub Release body from the matching version in `CHANGELOG.md`.

### Changed

- New direct-access installations start with self-signed HTTPS and print the certificate fingerprint. Existing installations keep their access mode until an administrator applies a certificate.
- Releases that remove existing behavior require review in Settings and are not installed by unattended automatic updates.

### Fixed

- The update check button now remains visible and disabled with a spinner while the panel checks for a new release.

### Security

- Native HTTPS uses Secure host cookies, redirects plain HTTP reads, rejects plain HTTP writes, and requires a new HTTPS sign-in after activation. Certificate changes reject a mismatched hostname, key, validity period, or chain.
- Agents reject RPC requests until the panel's handshake signature has been verified.

## [0.1.0-alpha.18] - 2026-10-02

### Changed

- Agents that predate remote self-update now say that a one-time manual upgrade is required and explain that later updates will work from the panel.

### Fixed

- Panel updates keep their target version in the URL, show a reconnecting loader, probe the panel automatically, reload the new frontend when it returns, and show the confirmed version after the refresh. A rollback or timeout now produces a specific recovery message.

## [0.1.0-alpha.17] - 2026-10-02

### Added

- Security settings can enable server-verified Cloudflare Turnstile, configure progressive or fixed sign-in delays, ban individual IP addresses, and optionally lock panel sign-in temporarily or permanently.
- Active IP bans can be reviewed and removed in Settings. A whole-panel lock can be cleared over SSH with `sudo unpanel-manage unlock`.
- After two failed passwords, the sign-in page shows how many attempts remain before an IP or whole-panel lock.
- Remote Linux agents can update to the running panel release from Settings, with architecture checks, SHA-256 verification, service restart verification, and automatic rollback when the new agent does not stay active.

### Changed

- Settings categories have icons, and settings and swap choices now use a keyboard-accessible custom dropdown.
- Updates has its own Settings screen with panel-first fleet guidance, per-node agent versions, and one-at-a-time update states. Panel update notices now live above Sign out in the sidebar, while About focuses on the running build, source, and license.

## [0.1.0-alpha.16] - 2026-10-02

### Changed

- Settings and swap choices use one keyboard-accessible control instead of browser-native select menus.

### Fixed

- A lost browser reply no longer claims a write did not happen. Restart, stop, update, settings, node, authentication, backup, and restore actions tell the user how to verify the result before retrying.
- Control and update failures keep their full, user-visible reason in Logs, including unexpected server errors.
- Local lint checks ignore generated release trees while continuing to check source files.

## [0.1.0-alpha.15] - 2026-10-02

### Fixed

- Creating a swap file no longer says that nothing changed when the page loses the reply. Logs records the request, the agent's reason, and a lost reply, and the row shows that sentence.

## [0.1.0-alpha.14] - 2026-10-02

### Added

- The address bar follows Overview, a node, Host, and Settings. Refresh opens that page. An unknown path says so and opens the overview.
- System history keeps every minute. The times sit under the chart. Moving across it shows that minute's reading, or that there was none. A gap is not drawn as zero.
- Settings saves how often the dashboard asks for numbers, how long minute history is kept, and how often to look for a release. A new release is shown on every page. Automatic install stays off until it is turned on, and it updates only this machine.
- Host can create a 1, 2, 4, or 8 GiB swap file when the machine has none. The root agent writes `/var/lib/unpanel-swap/swapfile`. An existing swap file is not replaced.
- The agent reports its package version. A remote node that is behind says to run its install command again. Updating the panel does not update a remote agent.
- A screen that is not built, including alerts and certificates, says what was not done.

### Changed

- Failed actions name what did not happen. Sign-in explains the existing attempt limits. The panel is not locked for every address. Turnstile is not connected. Automatic certificates are not issued.

## [0.1.0-alpha.13] - 2026-10-02

### Fixed

- Adding a node asks for the address of this panel, the one the new server opens. The field says so.
- When the agent cannot reach the panel, the installer names that address and why the connection failed.

## [0.1.0-alpha.12] - 2026-10-02

### Fixed

- The release package directory is mode 755. A mode 0700 directory stopped the unprivileged panel from starting. The swap sets that mode before the new process is started, and restores the previous directory if it still does not answer.

## [0.1.0-alpha.11] - 2026-10-02

### Changed

- Updates download the release package for this machine and check its SHA-256. The current install is moved to `/opt/unpanel.previous` before the new package replaces it. If the new process does not answer, that directory, the systemd units, and panel.env are put back.

## [0.1.0-alpha.10] - 2026-10-02

### Fixed

- A failed update no longer leaves the panel unreachable. The next version is built beside the running install. The running process is stopped only to swap in a finished tree. If that tree does not answer, the previous program, systemd units, and panel.env are put back and started. A package built for another architecture is refused before anything is stopped.

## [0.1.0-alpha.9] - 2026-10-02

### Added

- Release packages are built for linux-arm64 as well as linux-x64. The installer picks the package that matches the machine.
- When Node.js 24 is not already installed, the installer downloads the official linux-x64 or linux-arm64 build and checks its SHA-256.

## [0.1.0-alpha.8] - 2026-10-02

### Fixed

- The linux package from 0.1.0-alpha.7 stored the password hasher as a symlink to the CI machine. This release contains the binary.

## [0.1.0-alpha.7] - 2026-10-02

### Added

- A release tag builds a linux-x64 package in CI. `install.sh` downloads that package and checks its SHA-256. It does not clone the repository or build on the server.
- Settings → About checks for a newer release and can install it. The local agent downloads the package, and a failed start restores the previous install. The database is kept.
- A server that does not run the panel installs only the agent with `curl -fsSL https://unpanel.codenav.dev/install-agent.sh`.

## [0.1.0-alpha.6] - 2026-10-02

### Fixed

- Copy works on the plain HTTP panel page. The Clipboard API is unavailable there, so the button copies by selecting the text.
- A failed copy no longer says to start the panel with `pnpm dev`.
- The enrollment script runs under `sudo bash`, so pasting it into a login shell cannot close that session when a command fails.

## [0.1.0-alpha.5] - 2026-10-02

### Changed

- The installer detects the machine's public IPv4 when the address on the network interface is private. It asks the cloud metadata service first, then what address the internet sees. A saved private panel address is replaced when a later start has a public one.

## [0.1.0-alpha.4] - 2026-10-02

### Changed

- After install, the script prints the next steps in order: allow the panel's TCP port on the server and at the server provider, open the setup address and create the owner account, then sign in later without the token. A private address tells you to use the machine's public IP.

## [0.1.0-alpha.3] - 2026-10-02

### Fixed

- A fresh install no longer prints `id: 'unpanel': no such user`. That check runs before the system user exists, and the account is created on the next line.

## [0.1.0-alpha.2] - 2026-10-02

### Added

- Public site in `apps/site` for `unpanel.codenav.dev`. The one-line install is `curl -fsSL https://unpanel.codenav.dev/install.sh | sudo bash`. The built site includes that script.

### Fixed

- The installer no longer crashes with `Cannot access 'systemHost' before initialization` after the web build. The command was reading that object while it was still being created.

## [0.1.0-alpha.1] - 2026-10-02

### Fixed

- `curl | sudo bash` no longer insists on root's `node`. sudo resets PATH, so Ubuntu's Node 18 was selected instead of the Node 24 belonging to the account that ran sudo. A Node 24 that lives under a home directory is copied to `/usr/local/lib/unpanel-node` so the systemd service can run it.

## [0.1.0-alpha.0] - 2026-10-02

First pre-alpha. One command installs this version on Linux. There is no signed package yet.

### Added

- Monorepo skeleton: pnpm workspace, shared product identifiers, protocol error codes, web shell, and CI for lint, typecheck, and tests.
- Local agent handshake over an IPC socket, `system.info`, live CPU, memory, and disk tiles with sparklines, and uptime on the local node, and a dev page that shows the host after first-run setup and password plus TOTP login.
- Audit log with a hash chain over sign-in, sign-out, first-run setup, and node connection changes, readable at `GET /api/v1/audit` and from the dashboard's Logs dialog.
- Swap tile, an overall speed card with upload against download plus lifetime sent and received totals, and a connection stats card with TCP and UDP socket counts. Values a host cannot report stay unavailable instead of reading as zero.
- System strip showing panel and OS uptime, panel and agent memory, and the node's IP addresses behind an eye toggle that blurs them.
- Customize dialog to choose which dashboard cards are shown, remembered per browser.
- Restart and Stop ask the local agent to act on the panel systemd unit, behind a confirm dialog. Hosts without systemd refuse instead of killing a guessed process.
- Backup & Restore downloads an online snapshot of the panel database, or stages a previous snapshot to apply on the next process start. `master.key` is not in the file.
- System history opens in its own dialog with CPU, Memory, and Storage tabs and 1 hour / 24 hour / 7 day windows of minute averages.
- Host page for the local node: display name, tags, maintenance, and host facts.
- Settings page: Dark / Light / Ultra-dark stored on the panel, change password, and About (license and source URL). The login page shows the source link. Sections are Panel, Security, and About, with the panel address agents use to enroll.
- Add node on the overview. A one-hour enrollment token lets another `unpanel-agent enroll` and connect over WebSocket. Dashboard and Host follow the node you open.
- Disable, enable, re-enroll, and remove nodes. The local node cannot be re-enrolled or removed. A removed id stays revoked. A disabled agent retries once an hour. Right-click a sidebar node or an overview card for the same actions; Edit opens the Host form.
- One-command install of this version: `curl -fsSL https://raw.githubusercontent.com/codenav-ltd/unpanel/v0.1.0-alpha.0/scripts/install.sh | sudo bash`. It clones the tag, builds the web UI, and starts the panel and local agent under systemd. `scripts/update.sh` moves to a newer release tag, or fast-forwards a branch, and restores the previous version if the new process does not answer.
- Overview card size sits after the Overview title. Small shows name, status, usage, and tags. Medium adds the CPU rail and uptime. Large adds capacity, swap, load, traffic, and sockets. The choice stays in the browser.
- Design documentation: overview, architecture, agent protocol, node lifecycle, authentication, security, data model, HTTP API, frontend, deployment, testing.
- Module designs for monitoring, alerting, notifications, Docker, PM2, Nginx, systemd services, certificates, terminal and files, firewall, cron, probes, and backups.
- Architecture Decision Records 0001–0011.
- Trademark policy and Contributor License Agreement (drafts).

### Changed

- License changed from MIT to AGPL-3.0-or-later before any code was published ([ADR-0011](./docs/adr/0011-agpl-license.md)).
- Project named **Unpanel**; binaries, paths, systemd units, and environment variables use the `unpanel` prefix.
- Maintenance knowledge base for external systems, conventions, release process, troubleshooting, and runbooks.
- Repository community files: README, contributing guide, security policy, code of conduct, issue and pull request templates.
