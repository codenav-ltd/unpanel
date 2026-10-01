# Documentation

This directory is the single source of truth for the project's design and operational knowledge. **Change the docs first, then the code.** If a review finds that the implementation and the docs disagree, the review is not done until one of them is fixed.

> Product name: **Unpanel**. Binaries: `unpanel` (control plane) and `unpanel-agent` (node agent). In prose, "the panel" means the control-plane role and "the agent" the node daemon ([glossary](./kb/glossary.md)).

## Layout

```
docs/
├── README.md                  This file: index and conventions
├── open-questions.md          Pending decisions and their current defaults
├── design/                    System-level design ("what the system is and how it works")
│   ├── 00-overview.md         Scope, goals/non-goals, resource budgets, feature list, milestones
│   ├── 01-architecture.md     Components, process model, repo layout, request/stream lifecycle
│   ├── 02-agent-protocol.md   Panel <-> Agent protocol (frames, RPC, streams, backpressure, versioning)
│   ├── 03-node-lifecycle.md   Enrollment, identity, heartbeat, offline behavior, upgrades, batch ops
│   ├── 04-auth.md             Password, TOTP, passkeys, sessions, API tokens, RBAC
│   ├── 05-security.md         Threat model and hardening
│   ├── 06-data-model.md       Database schema and agent-local state
│   ├── 07-http-api.md         Browser <-> Panel API conventions, WebSocket topics, route catalog
│   ├── 08-frontend.md         Frontend architecture, layout, theming, components, live data
│   ├── 09-deployment.md       Packaging, installation, filesystem layout, config, upgrades
│   └── 10-testing.md          Test strategy, CI, quality gates
├── modules/                   One document per feature
│   ├── monitoring.md          Resource monitoring and traffic accounting
│   ├── alerting.md            Anomaly detection and the alert engine
│   ├── notifications.md       Notification channels and the Telegram bot
│   ├── docker.md
│   ├── pm2.md
│   ├── nginx.md
│   ├── services.md            systemd services and journald logs
│   ├── certificates.md        Issuance, renewal, distribution
│   ├── terminal-files.md      Web terminal and file manager
│   ├── firewall.md
│   ├── cron.md                Scheduled jobs
│   ├── probes.md              HTTP/TCP/ping probes
│   └── backup.md
├── adr/                       Architecture Decision Records
│   ├── README.md              Process and index
│   ├── template.md
│   └── NNNN-*.md
└── kb/                        Maintenance knowledge base (external-system facts, pitfalls, runbooks)
    ├── README.md              KB index
    └── *.md
```

## Reading order

1. New contributors: `design/00` → `design/01` → `adr/README` → the `modules/*` you care about
2. Working on an agent feature: `design/02` → the matching `modules/*` → the matching `kb/*`
3. Working on the frontend: `design/08` → `design/07` → `kb/ui-reference-3x-ui.md`
4. Something is broken in production: `kb/troubleshooting.md` → `kb/runbooks.md`

## Conventions

- **Language**: English, for code, docs, commit messages, issues, and UI strings (the UI ships with additional locales; see [design/08](./design/08-frontend.md)).
- **Status header**: every design doc starts with `Status: Draft | Review | Accepted | Superseded`.
- **ADRs are append-only**: when a decision changes, write a new ADR and mark the old one `Superseded by NNNN`.
- **The KB records facts and pitfalls**: behavior of external systems (Docker, Nginx, ACME, Telegram, ...) goes into `kb/` with a source link and a verification date. External behavior changes; always cite where a number came from.
- **Diagrams**: Mermaid, so they render on Git hosting platforms.
- **Normative code blocks**: TypeScript types and interfaces in design docs are normative. The implementation must match them; to deviate, update the doc first.
- **Links**: relative paths between docs.
- **Terminology**: see [kb/glossary.md](./kb/glossary.md). The most common terms:

| Term | Meaning |
|---|---|
| Panel | The control-plane process that serves the web UI and API and aggregates all nodes |
| Agent | The privileged process running on every managed server |
| Node | One managed server, i.e. one enrolled agent |
| Local node | The node on the same host as the panel (`nodeId = local`); it also runs a separate agent |
| Hub | The panel component that owns agent connections and routes RPCs |
| Capability | A feature an agent reports as available (e.g. `docker`, `pm2`) |
