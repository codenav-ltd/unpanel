# 0008 · Agent in Node, Protocol Kept Language-Agnostic

- Status: Accepted (confirmed 2026-10-01, [open-questions](../open-questions.md) Q4)
- Date: 2026-10-01
- Related: [design/02](../design/02-agent-protocol.md), [kb/node-runtime.md](../kb/node-runtime.md)

## Context

The agent runs on every managed server, so its footprint directly defines how "lightweight" the product feels. On the other hand, the panel and frontend are TypeScript; an agent in TypeScript can share protocol definitions, validation, and utilities, which is the most productive option.

## Decision

- The v1 agent is implemented in Node (TypeScript) and shares `packages/protocol` with the panel;
- The protocol is defined by its specification ([design/02](../design/02-agent-protocol.md)) and test vectors and **relies on no Node/JS-specific behavior**, so the agent can later be rewritten in Go or Rust without changing the panel.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Node agent + language-agnostic protocol (chosen) | One language across the stack; shared zod schemas; fastest development | ≈ 40–50 MB idle RSS; ships a Node runtime (≈ 30 MB compressed); native modules (node-pty) compiled per architecture |
| Go agent | Single static binary, ≈ 10–20 MB idle RSS; easy cross-compilation | Two languages; protocol defined twice (or code-generated); requires Go experience |
| Rust agent | Lowest footprint | Slowest development |
| Bun-compiled single file | Single-file distribution | Compatibility risk for native modules such as node-pty under Bun; runtime memory not much lower than Node |

## Consequences

- Positive: v1 can ship quickly; one protocol implementation to maintain.
- Negative: the agent memory budget is ≤ 50 MB, which takes discipline (lazy-loaded modules, no heavy dependencies, buffer reuse, no long-running child processes).
- Constraints (to keep a rewrite possible):
  - Every frame is JSON or the binary format defined in the spec; no JS-specific serialization;
  - Signed messages use the spec's canonicalJSON;
  - Cross-language test vectors live in `packages/protocol/test-vectors/`.
- Revisit when: many users run machines with 512 MB of RAM or less and the Node agent's memory use becomes a primary complaint.
