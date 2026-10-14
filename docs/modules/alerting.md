# Module · Anomaly Detection and Alerting

> Implemented in alpha.20: resource thresholds, offline nodes, active panel certificate expiry, incidents, maintenance suppression, acknowledgement and incident silences. Panel component: `apps/panel/src/alerts/`. Delivery: [notifications](./notifications.md).

## Current behavior

Alerts has four sections: Incidents, Rules, Notification channels, and Delivery log. Monitoring runs every 15 seconds with the browser closed. Opening live dashboards can increase sampling frequency through the existing shared cadence; alerting does not open another agent connection or start another metrics collector.

A rule has a condition, threshold, hold duration, severity, node selection, channel selection, recovery notification switch, and reminder interval. Empty node selection means all active nodes, including future additions. Empty channel selection means every enabled channel. Each channel's severity filter also applies. Rules and channels can be independently enabled or disabled.

From alpha.24, the editor shows the condition, threshold, duration presets and notification destination first. Names and thresholds start from sensible defaults when creating a rule. Advanced options contain node scope, severity, recovery and reminders. The UI explicitly offers **All active nodes** and **All enabled channels**; choosing specific nodes or channels requires at least one selection. Existing rules retain their advanced settings when edited.

Supported conditions (definitions, units and limits are shared in `ALERT_METRICS`):

| Condition | Value | Notes |
|---|---|---|
| CPU, memory, system disk, swap usage | % | Disk is the agent's system disk aggregate, not every mount. Swap without capacity is unknown, not zero. |
| System disk predicted to fill | hours until full | Least-squares fit over the last six hours of the minute history (`metrics/forecast.ts`), projected from the latest readings. Unknown until two hours of readings exist; a flat or shrinking disk reports “not filling” and clears. Clearing needs the forecast to move 50% past the warning level, because the projection moves between readings. |
| System disk inodes | % | `statfs` file counts reported by agents from alpha.42. Filesystems that allocate inodes on demand (Btrfs, many network mounts) report none and are skipped. |
| Load per CPU core | % of cores, up to 1000 | 5-minute load average ÷ threads. |
| Inbound / outbound traffic | Mbit/s | Sum of metered interfaces from the agent's byte rates. |
| Open TCP connections | count | From the agent's socket count; unknown where the host does not report it. |
| Server restarted | minutes of uptime | Fires while uptime is under the threshold and clears once it is past it; usually a single warning without a recovery message. |
| Node offline | — | Levels differ only by how long the node is gone. |
| Docker container down | — | One incident per container (target `<node>:container:<name>`, so a recreated container keeps its incident). Down means restarting, running but unhealthy, dead, or exited with a non-zero code. Not watched: clean exits (code 0), containers stopped or paused from Unpanel's Docker page, created or paused containers, and failures older than a day that the panel never saw running. The panel polls the agents' existing container list every 30 seconds, only for nodes an enabled container rule covers, so older agents work and no agent-side collector runs. A failed or stale poll keeps open incidents waiting rather than resolving them. Levels differ only by how long the container is down. |
| Panel certificate | days left | The certificate on the panel listener. |
| Managed certificates | days left | Every certificate in Certificates, one incident each; not certificates on arbitrary remote services. |

Rules can be added from **Add from templates** on the Rules tab: grouped templates (resources, network, availability, certificates) with a one-line reason and the levels they start with. A template becomes an ordinary rule for every node and every enabled channel; Edit adjusts it. The same templates provide the editor's starting values when the condition changes. Older releases ignore conditions they do not know, so a downgraded panel leaves such rules inert rather than failing.

A critical rule can carry an earlier **warning level** (alpha.41): its own threshold and hold duration, below the critical threshold (more days remaining for a certificate, a shorter outage for offline). One incident opens as a warning and is raised to critical in place, with one more notification marked “Now critical”; channels that accept only critical alerts receive that one. If the reading falls back under the critical threshold but stays past the warning, the incident steps back to warning quietly after 60 seconds. Recovery is measured against the warning threshold. Reminders repeat only while the incident is at the rule's top level, so an early warning is sent once. The editor shows the two levels as rows that can each be turned off; a single level is an ordinary rule of that severity. The warning level is an optional key in the stored rule JSON, so earlier releases still read the rule.

Default enabled rules (alpha.41; the last two from alpha.42), each warning first and then critical:

| Rule | Warning | Critical |
|---|---|---|
| Node offline | 1 minute | 5 minutes |
| CPU usage | ≥ 80% for 5 minutes | ≥ 90% for 5 minutes |
| Memory usage | ≥ 80% for 5 minutes | ≥ 90% for 3 minutes |
| System disk usage | ≥ 80% for 5 minutes | ≥ 90% for 1 minute |
| Swap usage | ≥ 50% for 10 minutes | ≥ 80% for 5 minutes |
| Panel certificate expiry | 21 days left | 7 days left |
| System disk filling up | full within 72 hours, for 30 minutes | full within 12 hours, for 15 minutes |
| Disk inodes | ≥ 80% for 5 minutes | ≥ 90% for 5 minutes |

After panel startup, a 180-second grace period precedes offline evaluation. Installations seeded before alpha.41 keep their rules. Rules tab offers **Use recommended rules** while any of the old seven defaults is still exactly as seeded; it replaces only those, adds the recommended rules whose names are missing, and leaves edited rules alone.

Default rules repeat hourly once critical. These are editable defaults, seeded only once. Removing every rule does not recreate them on restart. Without a notification channel, incidents still appear in the panel and an onboarding notice explains how to connect a destination. An incident is not marked notified until at least one eligible delivery is queued, so connecting the first channel can notify an already active incident on the next evaluation.

## State and recovery

The evaluator holds independent state for each rule/target pair: healthy, pending breach, firing, pending recovery. A resource recovers below 95% of its configured threshold; for a 90% threshold this means below 85.5%. Certificate recovery requires more than threshold + 1 days remaining. Every recovery must hold for 60 seconds.

Samples older than 45 seconds, disconnected nodes, or missing values reset pending timers but **do not resolve existing incidents**. The offline rule handles connectivity separately. Pending and disabled nodes are excluded. Node maintenance suppresses notifications while incidents continue to be recorded. Once maintenance ends, an incident that has never notified may send its initial notification.

Open incidents, acknowledgement, silence expiry, and last notification time survive panel restart. Pending breach/recovery timers restart conservatively. A unique database index prevents duplicate open incidents for the same rule/target. Changing a rule closes its old incidents with an explicit administrative reason and evaluates subsequent readings using the new settings. Removed, disabled, or replaced targets also end monitoring without a misleading recovery message.

Acknowledgement stops reminders. Incident silence offers 1 hour, 4 hours, 1 day, 7 days, and resume now. It suppresses messages for that incident, including recovery, without stopping evaluation. Node-wide scheduled maintenance and rule-wide scheduled silences are separate future features.

Active incidents are sorted by severity and start time. The UI shows the latest 100 resolved incidents; resolved records are retained for 90 days. Up to 100 rules and 20 notification channels can be configured. Delivery retention and retry behavior are described in [notifications](./notifications.md).

## User experience requirements

The interface must explain the next useful action: no channels leads to setup, no rules leads to rule creation, failed delivery leads to provider or destination guidance. Mutating actions show progress, prevent duplicate submissions, and retain actionable errors. Destructive actions require confirmation. Settings use accessible custom selects, labeled fields, keyboard-operable dialogs, and layouts that work on phones.

Telegram connection uses a guided, confirmed conversation discovery flow. Requiring ordinary users to find and paste a chat ID is not an acceptable primary setup flow. See [notifications](./notifications.md) for the exact contract.

## Planned extensions (not shipped)

Keep rule evaluation separate from notification providers so later conditions and delivery drivers can be added without coupling them to the UI or agent protocol. Planned conditions include per-mount disk and inodes, CPU iowait/steal, load per core, traffic quota, Docker OOM kills, PM2 failures, watched systemd services, probes, SSH login events, clock skew, and outdated agents.

Planned UX includes a historical rule preview, filterable incident timeline, resource deep links, scheduled silence management, and richer grouping. Alert-storm digests and mass-outage correlation are not implemented; the current queue bounds, cooldowns and delivery log make overload visible rather than silently dropping it.

The panel cannot send notifications while it is down. External heartbeat monitoring and an optional remote watcher are planned. A watcher would receive only send-only notification configuration, store it encrypted, and explicitly disclose the additional credential location to the user. Neither mechanism is enabled or provisioned by this release.
