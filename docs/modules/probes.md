# Module · Probes (Synthetic Checks)

> Status: Draft · Agent module: `probe`

## 1. Purpose

Check the availability of websites and services from the vantage point of one or more nodes. Multiple vantage points make it possible to tell "the service is really down" apart from "one network path is broken".

## 2. Kinds

| Kind | Parameters | Success when |
|---|---|---|
| `http` | URL, method, headers, body, timeout, follow redirects, verify TLS, expected status (e.g. `200-299`), keyword (contains / does not contain) | Status and keyword match; TLS certificate expiry is recorded too |
| `tcp` | host, port, timeout | A connection is established |
| `ping` | host, count (default 3), timeout | Packet loss below threshold; average latency recorded |
| `dns` (P2) | Name, record type, expected value, resolver | The answer matches |

`ping` uses the system `ping` command (`ping -n -c 3 -W 2 <host>`) and parses its output, since Node has no raw ICMP socket API. The target is strictly validated first (hostname or IP only) and passed in an argument array.

## 3. Scheduling

```mermaid
sequenceDiagram
  participant M as Panel
  participant A as Agents
  M->>A: probe.sync {probes:[...]} (only the probes this node runs)
  loop each probe at its own interval (with jitter)
    A->>A: Run the check
  end
  A->>M: evt probe.results (batched every 60 s; buffered while offline)
  M->>M: Store probe_results → evaluate quorum
```

- Probes are **scheduled locally by the agent**; the panel does not send a command per check. Configuration changes trigger a new `probe.sync`.
- Minimum interval is 30 s.

**Quorum**: a probe is "down" only when at least `quorum` vantage nodes have **each** failed `consecutiveFailures` times in a row. Offline vantage nodes do not vote; if fewer than `quorum` nodes can vote, the state is "unknown" and no alert fires.

## 4. Security

- Probes send requests from nodes and can reach the node's internal network. That is the point of the feature, but it can be abused, e.g. to read cloud metadata endpoints.
- Default node policy: `[probe] deny_cidrs = ["169.254.169.254/32", "fd00:ec2::254/128", "100.100.100.200/32"]` (AWS/GCP/Alibaba Cloud metadata addresses). Resolved addresses of hostnames are checked as well.
- Probe results **never include response bodies** — only status, timing, keyword match, and error type — so a probe cannot be used as a proxy for reading internal data.
- Creating and editing require `probe:write`.

## 5. UI

- List: one row per probe with a status bar of the last 90 intervals (green / red / grey), 24-hour availability, and average latency.
- Details: latency curves per vantage node (overlaid on one chart), outage periods, certificate expiry.
- Public status page (P2): optional read-only page for a chosen set of probes.
