# Glossary

| Term | Identifier | Meaning |
|---|---|---|
| Panel | `unpanel` | The control-plane service that serves the web UI and API and aggregates all nodes; runs as the `unpanel` user |
| Agent | `unpanel-agent` | The root daemon on every managed server; performs all system operations |
| Node | — | A managed server, equivalent to one enrolled agent |
| Local node | `nodeId = local` | The node on the same machine as the panel, connected over a Unix socket |
| Hub | Node Hub | Panel component that holds agent connections, routes RPCs, and multiplexes streams |
| Capability | — | A feature (and its version) reported by an agent, e.g. `docker`, `nginx`, `pm2` |
| Method | — | One RPC in the protocol, named `<module>.<resource>.<action>` |
| Risk level | `risk` | How dangerous a method is: `read` / `write` / `danger` |
| Stream | — | A uni- or bidirectional data channel in the protocol (terminal, logs, file transfer) with its own channel number and flow control |
| Credit window | — | Flow-control mechanism: the receiver grants the sender a number of bytes it may send |
| Local policy | `policy.toml` | Node-local security switches that the panel cannot modify |
| Sudo mode | elevated session | Short-lived (10 minutes) authorization for dangerous operations, obtained by re-authenticating |
| Enrollment token | `pe_...` | One-time token generated when adding a node; valid for 1 hour |
| Panel identity key | — | The panel's Ed25519 key, used to prove its identity to agents and sign dangerous requests |
| Master key | `master.key` | AES-256 key that encrypts sensitive database columns |
| Job | — | A long-running panel task (certificate issuance, image pull, backup, batch operation) with progress and logs |
| Managed resource | — | Configuration defined by the panel and rendered on a node (Nginx sites, cron jobs), carrying a marker |
| Drift | — | A managed resource was edited by hand on the node and no longer matches the panel's record |
| Snapshot | — | The panel's cached runtime state of a node, shown while the node is offline |
| Rule / Series / Incident | — | See [modules/alerting.md](../modules/alerting.md) §1 |
| Silence | — | Suppresses notifications for matching alerts for a period |
| Maintenance | — | Node-level silence; the node's rules are not evaluated |
| Quorum | — | Minimum number of failing vantage nodes for a probe to be considered down |
| Pulse Rail | `PulseRail` | The thin strip at the top of a node card showing the last 10 minutes of CPU; the UI's signature element |
| Exposure | — | The set of ports actually reachable from the internet |
