# Module · Anomaly Detection and Alerting

> Implemented in alpha.20: resource thresholds, offline nodes, active panel certificate expiry, incidents, maintenance suppression, acknowledgement and incident silences. Panel component: `apps/panel/src/alerts/`. Delivery: [notifications](./notifications.md).

## Current behavior

Alerts has four sections: Incidents, Rules, Notification channels, and Delivery log. Monitoring runs every 15 seconds with the browser closed. Opening live dashboards can increase sampling frequency through the existing shared cadence; alerting does not open another agent connection or start another metrics collector.

A rule has a condition, threshold, hold duration, severity, node selection, channel selection, recovery notification switch, and reminder interval. Empty node selection means all active nodes, including future additions. Empty channel selection means every enabled channel. Each channel's severity filter also applies. Rules and channels can be independently enabled or disabled.

Supported conditions are CPU, memory, system disk and swap usage, node offline, and **the active panel certificate**. Disk is the existing agent's system disk aggregate, not every mounted filesystem. Swap without configured capacity and missing readings are unknown, not zero. Certificate expiry watches the panel listener, not certificates on arbitrary remote services.

Default enabled rules:

- Node offline for 120 seconds: critical. After panel startup, a separate 180-second grace period precedes offline evaluation.
- System disk usage at least 90% for 5 minutes: warning; at least 97% for 1 minute: critical.
- Memory usage at least 95% for 5 minutes: warning.
- CPU usage at least 95% for 10 minutes: warning.
- Active panel certificate has at most 14 days remaining: warning; at most 3 days: critical.

Critical defaults repeat hourly; warning defaults do not repeat. These are editable defaults, seeded only once. Removing every rule does not recreate them on restart. Without a notification channel, incidents still appear in the panel and an onboarding notice explains how to connect a destination. An incident is not marked notified until at least one eligible delivery is queued, so connecting the first channel can notify an already active incident on the next evaluation.

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

Keep rule evaluation separate from notification providers so later conditions and delivery drivers can be added without coupling them to the UI or agent protocol. Planned conditions include per-mount disk/inodes, CPU iowait/steal, load per core, traffic quota, disk-full forecast, Docker crash/OOM/restart loops, PM2 failures, watched systemd services, probes, SSH login events, clock skew, and outdated agents.

Planned UX includes a historical rule preview, filterable incident timeline, resource deep links, scheduled silence management, and richer grouping. Alert-storm digests and mass-outage correlation are not implemented; the current queue bounds, cooldowns and delivery log make overload visible rather than silently dropping it.

The panel cannot send notifications while it is down. External heartbeat monitoring and an optional remote watcher are planned. A watcher would receive only send-only notification configuration, store it encrypted, and explicitly disclose the additional credential location to the user. Neither mechanism is enabled or provisioned by this release.
