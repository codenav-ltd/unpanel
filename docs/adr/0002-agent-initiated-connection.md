# 0002 · Agents Connect to the Panel

- Status: Accepted (confirmed 2026-10-01, [open-questions](../open-questions.md) Q1)
- Date: 2026-10-01
- Related: [design/02](../design/02-agent-protocol.md), [design/03](../design/03-node-lifecycle.md)

## Context

The panel and each agent need a long-lived bidirectional channel: the panel sends commands, the agent pushes metrics and events. Who initiates the connection determines port exposure on nodes, NAT traversal, and deployment complexity.

## Decision

The agent opens a long-lived WebSocket-over-TLS connection to the panel (the local node uses a Unix socket). Agents listen on no ports.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Agent → panel (chosen) | Zero open ports on nodes, smallest attack surface; nodes can sit behind NAT or residential connections; node firewalls need no changes for the panel | The panel must be reachable by every node; changing the panel address requires notifying all agents |
| Panel → agent | The panel can live on a private network; matches the usual client/server intuition | Every node opens a port (every node becomes attack surface); nodes behind NAT cannot be managed |
| Support both | Flexible | Two sets of connection management and authentication logic; double the test matrix |

## Consequences

- Positive: nothing listens on nodes; installing the agent needs no firewall changes.
- Negative: panel reachability is a single point of failure; panel address changes go through the `agent.endpoint.update` flow (see [kb/runbooks.md](../kb/runbooks.md)).
- Revisit when: there is strong demand for "panel on a private network, nodes on the internet, panel cannot be exposed". A panel-initiated transport could then be added without protocol changes (handshake and framing reused verbatim, only the connection direction flips).
