# Open questions

> Status: living document. Every item has a **current default**; development proceeds on the default. Once confirmed or overturned, move it to "Decided" and link the ADR.

## Open

| # | Question | Current default | Affects | Ref |
|---|---|---|---|---|
| Q6 | Support Caddy / OpenResty? | v1: Nginx only, with a web-server abstraction left open | nginx module | [modules/nginx.md](./modules/nginx.md) |
| Q7 | Support Podman? | Not guaranteed in v1; may work through its Docker-compatible API | docker module | [modules/docker.md](./modules/docker.md) |
| Q8 | Support non-systemd distros (Alpine/OpenRC)? | No | Deployment, services module | [design/09](./design/09-deployment.md) |
| Q9 | App store / one-click templates? | Not in v1; Compose stack management covers it | docker module | — |
| Q10 | Depend on restic for backups? | No; built-in tar + gzip + encryption, optional restic when detected | backup module | [modules/backup.md](./modules/backup.md) |
| Q12 | SQLite driver | better-sqlite3; evaluate `node:sqlite` during M0 | Panel, packaging | [ADR-0006](./adr/0006-sqlite-drizzle.md) |

## Decided

| # | Question | Decision | Ref |
|---|---|---|---|
| Q1 | Connection direction between panel and agents | Agents dial the panel (WSS; Unix socket for the local agent). Nodes open no ports | [ADR-0002](./adr/0002-agent-initiated-connection.md) |
| Q2 | User model | Switchable: single-user mode by default, team mode with node-scoped RBAC. One authorization engine in both modes | [ADR-0009](./adr/0009-multi-user-rbac.md), [design/04](./design/04-auth.md) §12.5 |
| Q3 | Frontend component library | Ant Design Vue 4, with our own wrappers for signature visuals and a single theme source to limit exposure to its slow release cadence | [ADR-0007](./adr/0007-ant-design-vue.md) |
| Q4 | Agent implementation language | Node (TypeScript), protocol kept language-agnostic | [ADR-0008](./adr/0008-node-agent-language-agnostic-protocol.md) |
| Q5 | Project name | **Unpanel** ("the server panel that doesn't act like one"). Binaries `unpanel` / `unpanel-agent`; paths `/etc/unpanel`, `/var/lib/unpanel`, `/run/unpanel`; units `unpanel.service` / `unpanel-agent.service`; env prefix `UNPANEL_`. Repository: `codenav-ltd/unpanel`; project domain: `unpanel.codenav.dev` ([kb/release-process.md](./kb/release-process.md) §2) | [kb/conventions.md](./kb/conventions.md) §3 |
| Q11 | License | AGPL-3.0-or-later (replaces the MIT license of the initial commit; no code had been published under it). Bundled third-party code must be permissive; no code copied from other panels; source link in the UI | [ADR-0011](./adr/0011-agpl-license.md), [kb/conventions.md](./kb/conventions.md) §10–11 |
