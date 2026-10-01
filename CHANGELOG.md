# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
