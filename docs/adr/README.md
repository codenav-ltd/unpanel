# Architecture Decision Records (ADRs)

ADRs record *why*. The code shows what the system is; ADRs explain why it is that way, and which alternatives were considered and rejected.

## Rules

1. Write an ADR for any decision that affects several modules, is hard to reverse, or invites "why not X?".
2. File name `NNNN-kebab-case-title.md`, numbered sequentially, copied from [template.md](./template.md).
3. Status: `Proposed` → `Accepted` → (later, possibly) `Superseded by NNNN` or `Deprecated`.
4. **Accepted ADRs are not edited** (typos excepted). To change a decision, write a new ADR and mark the old one `Superseded by NNNN`.
5. Design documents related to an ADR reference it at the top.

## Index

| No. | Title | Status |
|---|---|---|
| [0001](./0001-uniform-node-abstraction.md) | Uniform node abstraction: the local machine is a node too | Accepted |
| [0002](./0002-agent-initiated-connection.md) | Agents connect to the panel | Accepted |
| [0003](./0003-unprivileged-panel-local-agent.md) | Unprivileged panel with a separate local agent | Accepted |
| [0004](./0004-self-built-auth.md) | Build authentication from primitives instead of a framework like better-auth | Accepted |
| [0005](./0005-hono.md) | Hono as the HTTP framework | Accepted |
| [0006](./0006-sqlite-drizzle.md) | SQLite (better-sqlite3) + Drizzle | Accepted |
| [0007](./0007-ant-design-vue.md) | Ant Design Vue 4 as the component library | Accepted |
| [0008](./0008-node-agent-language-agnostic-protocol.md) | Agent in Node, protocol kept language-agnostic | Accepted |
| [0009](./0009-multi-user-rbac.md) | Switchable user modes: single-user by default, team mode with node-scoped RBAC | Accepted |
| [0010](./0010-https-by-default.md) | HTTPS by default (starting with a self-signed certificate) | Accepted |
| [0011](./0011-agpl-license.md) | AGPL-3.0-or-later | Accepted |

"Q" numbers refer to [open-questions.md](../open-questions.md).
