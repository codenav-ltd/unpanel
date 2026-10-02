# 00 · Overview

> Status: Draft

## 1. Positioning

A **lightweight, good-looking, secure, and practical** multi-server management panel.

- Target users: individual developers and small teams running 1–100 VPS or dedicated servers.
- Core use: one web UI to see load and alerts across all servers; manage Docker, PM2, Nginx, and systemd services; issue and distribute certificates; get Telegram notifications and take simple actions when something goes wrong.
- How it differs from heavyweight panels: **no "one-click LNMP stacks"** and no reshaping of the system. It observes and manages what already exists, keeps its footprint small, and treats multiple nodes as a first-class concept.
- The UI takes inspiration from the dashboard and overall style of [3x-ui](https://github.com/MHSanaei/3x-ui); see [kb/ui-reference-3x-ui.md](../kb/ui-reference-3x-ui.md).

## 2. Design principles

1. **Uniform node abstraction**: the local machine is also a node. Every feature is implemented once, in the agent; the panel only authenticates, routes, and aggregates. ([ADR-0001](../adr/0001-uniform-node-abstraction.md))
2. **Least privilege**: the internet-facing panel process does not run as root. Privileged operations are only reachable through named, schema-validated agent RPCs. There is no generic "run this command" endpoint; the web terminal is an explicit exception that each node can disable locally.
3. **Secure by default**: HTTPS from the first visit (self-signed), no default password, mandatory first-run setup, step-up authentication for dangerous actions, full audit log.
4. **Pay only for what is watched**: no browser stream stays active when nobody is looking; lightweight background checks continue for monitoring; subscribe instead of polling wherever possible; modules that are not used do not stay resident.
5. **Recoverable**: every configuration change can be rolled back (Nginx, firewall, cron); lost 2FA can be recovered with a local CLI on the server; the panel itself can be backed up and migrated.
6. **Non-invasive**: never rewrite configuration the user already has; everything the panel manages lives in clearly marked, separate files or blocks.
7. **Docs first**: see [docs/README.md](../README.md).
8. **Professional without unnecessary complexity.** Configuration follows the user's task: guided discovery, understandable provider choices, explicit confirmation of destinations, and useful defaults. A Telegram user must not need to find a chat ID.
9. **The interface is part of the product.** A small process and a quiet agent do not mean a static screen. Motion, empty and error states, and the response to every action are designed with the feature. See [design/08](./08-frontend.md) §3.

## 3. Goals and non-goals

### Goals (v1)

- Multi-node: add and remove nodes, tags, cross-node overview, batch operations
- Monitoring: CPU, memory, swap, disk, network, IO, load, connections; live and historical charts; monthly traffic accounting
- Docker: containers, images, networks, volumes, Compose stacks, logs, terminals, resource stats
- PM2: process list, start/stop, reload, logs, multiple PM2 users
- Nginx: site management (templates and raw editing), config testing, rollback, logs
- systemd services: status, start/stop, enable on boot, journal logs
- Certificates: ACME (HTTP-01 and DNS-01), automatic renewal, distribution to many nodes, expiry monitoring for external certificates
- Alerting: threshold rules, event rules, silences, maintenance mode, recovery notifications
- Notifications: Telegram bot (including interactive commands), email via selectable SMTP/API providers, and an extensible channel abstraction (webhooks, etc.)
- Authentication: password + TOTP + passkeys, recovery codes, session management, API tokens; single-user mode by default, switchable to team mode with node-scoped RBAC
- Web terminal and file manager
- Firewall (ufw / nftables): read-only view plus changes with automatic rollback
- Scheduled jobs (managed cron file)
- Probes (HTTP/TCP/ping from multiple vantage points)
- Backups (panel data, paths, Docker volumes → local / S3 / WebDAV)
- Online upgrades for the panel and agents

### Non-goals

- One-click LNMP, site builders, app-store templates (Compose stacks cover this)
- Kubernetes management
- Multi-tenant SaaS, billing
- Windows/macOS managed nodes; non-systemd distributions
- Mail servers, DNS servers, database internals (databases, tables, users)
- Proxy-protocol node management (3x-ui's core job); possible later as a plugin

## 4. Supported platforms

| Item | v1 |
|---|---|
| Distributions | Debian 11/12/13, Ubuntu 22.04/24.04, AlmaLinux/Rocky 9 (best effort) |
| Architectures | `x86_64`, `aarch64` |
| Init | systemd (required) |
| Kernel | ≥ 4.18 (both cgroup v1 and v2 handled; v2 preferred) |
| Browsers | Last two major versions of Chrome, Edge, Firefox, Safari |
| Node runtime | Node 24 LTS; bundling is planned. Current installers require a separately installed Node 24 runtime. |

## 5. Resource budgets (v1 targets)

These are design targets, not certified measurements of the current pre-alpha. CI runs lint, type checks and functional tests; it does not yet enforce a fleet RSS/CPU, database-growth or bundle-size budget. A Linux VM and node-simulator benchmark is still required before claiming these limits. Current history stores minute data for the configured retention period; hourly/yearly compaction is not implemented.

| Metric | Target | Notes |
|---|---|---|
| Agent idle RSS | ≤ 50 MB | With nobody subscribed to live data |
| Agent idle CPU | ≤ 0.5% of one core | 10 s sampling interval |
| Panel idle RSS | ≤ 100 MB | 10 nodes online |
| Panel RSS with 100 nodes | ≤ 200 MB | Measured with the node simulator |
| Panel ↔ agent idle traffic | ≤ 2 KB/s per node | 10 s fast metrics + heartbeats |
| Frontend initial JS (gzip) | ≤ 300 KB | Terminal, editor, file manager, and module pages are lazy-loaded |
| Database growth | ≤ 5 MB per node per year | 1-minute data for 7 days + hourly data for 1 year |
| Release tarball | ≤ 60 MB per architecture | Including the Node runtime |

## 6. Features and priorities

P0 = required for the first usable build; P1 = required for v1.0; P2 = v1.x.

| Feature | Priority | Milestone | Doc |
|---|---|---|---|
| Monorepo skeleton, protocol package, agent connection | P0 | M0 | [design/02](./02-agent-protocol.md) |
| First-run setup, password + TOTP, sessions | P0 | M0 | [design/04](./04-auth.md) |
| Passkeys, recovery codes, sudo mode | P0 | M1 | [design/04](./04-auth.md) |
| Node enrollment / removal / tags | P0 | M1 | [design/03](./03-node-lifecycle.md) |
| Monitoring (live + history), multi-node overview | P0 | M1 | [modules/monitoring.md](../modules/monitoring.md) |
| Docker containers / images / logs / terminal | P0 | M2 | [modules/docker.md](../modules/docker.md) |
| Web terminal, file manager | P0 | M2 | [modules/terminal-files.md](../modules/terminal-files.md) |
| systemd services + journal | P0 | M3 | [modules/services.md](../modules/services.md) |
| Nginx sites | P0 | M3 | [modules/nginx.md](../modules/nginx.md) |
| Certificate issuance and distribution | P0 | M3 | [modules/certificates.md](../modules/certificates.md) |
| Alert engine + Telegram and email | P0 | M4 | [modules/alerting.md](../modules/alerting.md) |
| Team mode (users, roles, scoped bindings), API tokens | P1 | M4 | [design/04](./04-auth.md) §12.5 |
| PM2 | P1 | M5 | [modules/pm2.md](../modules/pm2.md) |
| Compose stacks | P1 | M5 | [modules/docker.md](../modules/docker.md) |
| Managed cron | P1 | M5 | [modules/cron.md](../modules/cron.md) |
| Firewall | P1 | M5 | [modules/firewall.md](../modules/firewall.md) |
| Probes | P1 | M5 | [modules/probes.md](../modules/probes.md) |
| Monthly traffic + quota alerts | P1 | M5 | [modules/monitoring.md](../modules/monitoring.md) |
| Online upgrades (panel + agents) | P1 | M6 | [design/09](./09-deployment.md) |
| Backup and restore | P1 | M6 | [modules/backup.md](../modules/backup.md) |
| Interactive Telegram remediation commands | P2 | — | [modules/notifications.md](../modules/notifications.md) |
| Terminal session recording | P2 | — | [modules/terminal-files.md](../modules/terminal-files.md) |
| Webhook / Bark channels | P2 | — | [modules/notifications.md](../modules/notifications.md) |

## 7. Milestones and exit criteria

| Milestone | Scope | Exit criteria |
|---|---|---|
| M0 Skeleton | Monorepo, protocol package, panel + local agent connected, first-run setup, password + TOTP login | `pnpm dev` starts everything; the local node is online; after login, `system.info` for node `local` is visible |
| M1 Nodes & monitoring | Remote enrollment, passkeys, metric collection / storage / charts, 3x-ui-style dashboard, multi-node overview | Two VMs enrolled; history is backfilled after a network cut; resource budgets met |
| M2 Docker & terminal | Full container lifecycle, log streaming, container/host terminals, file manager | Terminal is smooth at 100 ms RTT; huge logs do not freeze the frontend |
| M3 Services, Nginx, certificates | systemd, Nginx sites, ACME issuance and distribution | One wildcard certificate issued and deployed to two nodes; a deliberately broken config is rolled back automatically |
| M4 Alerts & team mode | Rule engine, Telegram, team mode (the RBAC engine itself exists from M0) | A Telegram alert arrives within 2 minutes of a node losing network, and a recovery message follows; switching team → single revokes every other user's access |
| M5 Ops tools | PM2, Compose, cron, firewall, probes, traffic | A bad firewall change is reverted automatically after 60 s |
| M6 Delivery | Online upgrades, backups, install script, docs | One-command install; a failed upgrade rolls back automatically |
