# 0001 · Uniform Node Abstraction: the Local Machine Is a Node Too

- Status: Accepted
- Date: 2026-10-01
- Related: [design/01](../design/01-architecture.md)

## Context

The panel must manage many servers from one place, and every feature (Docker, PM2, Nginx, monitoring, certificates, …) must work well across nodes. The common approach is to build a single-server panel first and "add" multi-node later. The result is usually two code paths per feature (direct local calls vs. remote API), with the multi-node version always lagging behind and always buggier.

## Decision

All server operations are implemented **only in the agent**. The panel never touches the operating system directly — even the machine it runs on is managed through a separate local agent (`nodeId = local`). Every API is organized as `/nodes/:nodeId/...`.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Uniform node abstraction (chosen) | One code path; a single server is just a one-node fleet; privilege separation comes naturally (see 0003) | Single-server installs run one extra process (≈ 40–50 MB RAM); local operations pay one IPC hop |
| Built-in local capabilities + remote agents | Fewer resources on single-server installs | Two code paths; features land locally first and remote lags; the panel must run as root |
| SSH-only remote execution, no agent | Nothing to install on nodes | Spawning processes and parsing text for every operation; no event push or live monitoring; centralizing SSH credentials is a large risk |

## Consequences

- Positive: every feature supports multiple nodes by construction; tests cover a single path; the panel can run unprivileged.
- Negative: single-server users pay the memory of one agent process; the protocol must be genuinely good (streams, backpressure, events) because everything depends on it.
- Revisit when: single-server users dominate and are very sensitive to ~40 MB of RAM. An optional "panel and agent merged into one root process" mode could then be offered — but it gives up the security benefits of 0003 and must only ever be an explicit opt-in.
