# Module · Firewall and Exposure

> Status: Draft · Agent module: `fw` · External details: [kb/firewall.md](../kb/firewall.md)

## 1. Backends

| Backend | v1 support | Detection |
|---|---|---|
| ufw | Read/write | `ufw status verbose`, plus `ENABLED` in `/etc/ufw/ufw.conf` |
| firewalld | Read/write in P2 | `firewall-cmd --state` |
| nftables | Read-only | `nft -j list ruleset` (JSON output) |
| iptables | Read-only | `iptables-save` / `ip6tables-save` |

Only one "primary backend" is recognized at a time: ufw or firewalld when enabled, otherwise nftables/iptables shown read-only.

## 2. The most important problem: don't lock yourself out

Every rule change goes through a **two-phase commit with automatic rollback**:

```mermaid
sequenceDiagram
  participant B as Browser
  participant M as Panel
  participant A as Agent
  B->>M: Submit changes
  M->>A: fw.apply {changes}
  A->>A: Snapshot current rules (ufw: copy /etc/ufw/*.rules and ufw.conf)
  A->>A: Register safety timer: systemd-run --on-active=90s unpanel-agent fw-restore <snapshot>
  A->>A: Apply changes
  A-->>M: {applyId, revertAt: now+60s}
  M-->>B: Show a 60-second confirmation countdown
  B->>M: fw.confirm {applyId} (if this request arrives, browser → panel → agent still works)
  M->>A: fw.confirm
  A->>A: Cancel the in-process timer and the systemd safety timer
  Note over A: No confirmation within 60 s:<br/>the agent restores the snapshot; if the agent crashed, the 90 s systemd timer restores it
```

- **Why a systemd safety timer**: if the new rules happen to cut the agent off from the panel, or the agent itself misbehaves, an in-process timer alone is not reliable enough.
- The agent's connection to the panel is **outbound**, and established connections are usually unaffected by inbound rules. It can still break if rules restrict outbound traffic or flush connection tracking.
- Only one pending change per node at a time (node-level lock).

## 3. Self-protection checks

Changes are simulated before being applied. These are rejected unless the user ticks "I know what I'm doing" and confirms again:

- Default inbound policy is deny but the SSH port is not allowed (the actual `port` is read via `sshd -T`);
- On the panel's own node, the panel port is not allowed;
- Deleting the rule that allows SSH or the panel port.

## 4. Docker and ufw

Docker publishes container ports through the iptables `DOCKER` chain and NAT rules, and that traffic **bypasses ufw's INPUT rules**. Users believe ufw blocks port 5432, but a port published with `-p 5432:5432` is still reachable from the internet.

What the panel does:

- The firewall page explicitly lists "ports published by Docker that ufw does not control";
- It suggests fixes: bind to `127.0.0.1:5432:5432`, or add rules to the `DOCKER-USER` chain (see the KB);
- v1 does not modify `DOCKER-USER` automatically.

## 5. Exposure view

Three sources merged into one table that answers "which ports on this machine are reachable from the internet":

| Port | Proto | Listen address | Process / container | Firewall | Verdict |
|---|---|---|---|---|---|
| 22 | tcp | 0.0.0.0 | sshd | Allowed | 🟢 Public (expected) |
| 5432 | tcp | 0.0.0.0 | docker: postgres | Not allowed, but Docker bypasses | 🔴 Unexpectedly public |
| 6379 | tcp | 127.0.0.1 | redis-server | — | ⚪ Local only |

Sources: `system.ports` (`ss -tulpnH`) + parsed firewall rules + Docker port mappings.

## 6. Methods

| Method | Risk | Notes |
|---|---|---|
| `fw.status` | read | Backend, enabled state, default policies, structured rule list |
| `fw.exposure` | read | Exposure view (§5) |
| `fw.apply` | danger | A set of changes: `allow` / `deny` / `limit` / `delete` / `enable` / `disable` / `default`; returns `applyId` |
| `fw.confirm` | danger | Confirm the change |
| `fw.revert` | danger | Roll back immediately |

Rule structure (ufw):

```ts
interface FwRule { id: number; action: "allow" | "deny" | "reject" | "limit"; direction: "in" | "out";
  port?: string /* "80" | "8000:8100" */; proto?: "tcp" | "udp" | "any";
  from?: string /* CIDR or "any" */; to?: string; iface?: string; comment?: string; v6: boolean }
```

ufw commands always take argument arrays, e.g. `ufw allow proto tcp from 1.2.3.0/24 to any port 443 comment panel:<id>`. Rule-changing ufw commands do not prompt; `ufw enable` needs `--force` to skip its interactive prompt.

## 7. Out of scope

Cloud provider security groups. The UI notes that "cloud security groups must be configured separately in your provider's console".
