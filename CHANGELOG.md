# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
