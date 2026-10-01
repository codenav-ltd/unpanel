# 0003 · Unprivileged Panel with a Separate Local Agent

- Status: Accepted
- Date: 2026-10-01
- Related: [design/01](../design/01-architecture.md) §3, [design/05](../design/05-security.md), [design/09](../design/09-deployment.md)

## Context

The panel is an internet-facing web service that processes large amounts of external input (HTTP, WebSocket, uploads, data reported by agents). It is the most exposed part of the system. Common panels, 3x-ui included, run their web process as root, so any remote code execution bug immediately yields root.

The initial idea was for the local node to be "called in-process by the panel", which would require the panel to run as root.

## Decision

- The panel runs as the system user `unpanel` with the full systemd sandbox enabled;
- The local machine also runs a separate `unpanel-agent` (root) that connects to the panel over the Unix socket `/run/unpanel/agent.sock`, using **exactly the same** handshake and protocol as remote agents;
- Privileged operations the panel needs (self-upgrade, database restore, deploying its own TLS certificate) go through the local agent.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Unprivileged panel + separate local agent (chosen) | A compromised panel can only call the agent's named RPCs, constrained by local policy — no arbitrary root shell; fully consistent with 0001 | One more process; panel upgrades go through the local agent, which is slightly more involved |
| Root panel, in-process calls | One fewer process, simpler deployment | Any RCE = root |
| Unprivileged panel + sudo allowlist | No extra process | sudo rules are hard to make both safe and sufficient; high argument-injection risk; rules to maintain per feature |

## Consequences

- Positive: greatly reduces the blast radius of a panel compromise; the systemd sandbox can be as strict as possible.
- Negative: ≈ 40–50 MB extra RAM on single-server installs; binding ports 80/443 needs `CAP_NET_BIND_SERVICE`; panel upgrades are performed by the local agent (see [design/09](../design/09-deployment.md) §6.2).
- Note: this isolation only holds if (1) the agent offers no generic command execution, and (2) high-risk capabilities such as the web terminal are governed by node-local policy. Every new agent method must preserve both.
