// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export type AlertSeverity = "warning" | "critical";
export type AlertMetric =
  | "offline"
  | "cpu"
  | "memory"
  | "disk"
  | "disk_forecast"
  | "inodes"
  | "swap"
  | "load"
  | "network_in"
  | "network_out"
  | "connections"
  | "restarted"
  | "container"
  | "certificate"
  | "certificates";

export interface AlertMetricSpec {
  label: string;
  /** Unit the threshold is written in. */
  unit: "%" | "Mbit/s" | "connections" | "min" | "hours" | "days" | "";
  /**
   * `above` fires at or above the threshold, `below` at or below it. `none` is a yes-or-no state
   * (offline, a container down) whose levels differ only in how long it lasts.
   */
  direction: "above" | "below" | "none";
  min: number;
  max: number;
  /** Panel-wide targets instead of nodes. */
  panel?: true;
}

/** Conditions a rule can watch. Shared so the editor and the evaluator agree on units and limits. */
export const ALERT_METRICS: Record<AlertMetric, AlertMetricSpec> = {
  offline: { label: "Node goes offline", unit: "", direction: "none", min: 1, max: 1 },
  cpu: { label: "CPU usage", unit: "%", direction: "above", min: 1, max: 100 },
  memory: { label: "Memory usage", unit: "%", direction: "above", min: 1, max: 100 },
  disk: { label: "System disk usage", unit: "%", direction: "above", min: 1, max: 100 },
  disk_forecast: {
    label: "System disk predicted to fill",
    unit: "hours",
    direction: "below",
    min: 1,
    max: 720,
  },
  inodes: { label: "System disk inodes used", unit: "%", direction: "above", min: 1, max: 100 },
  swap: { label: "Swap usage", unit: "%", direction: "above", min: 1, max: 100 },
  load: {
    label: "Load per CPU core (5-minute average)",
    unit: "%",
    direction: "above",
    min: 1,
    max: 1000,
  },
  network_in: {
    label: "Inbound traffic",
    unit: "Mbit/s",
    direction: "above",
    min: 1,
    max: 100_000,
  },
  network_out: {
    label: "Outbound traffic",
    unit: "Mbit/s",
    direction: "above",
    min: 1,
    max: 100_000,
  },
  connections: {
    label: "Open TCP connections",
    unit: "connections",
    direction: "above",
    min: 1,
    max: 1_000_000,
  },
  restarted: { label: "Server restarted", unit: "min", direction: "below", min: 1, max: 1440 },
  container: {
    label: "A Docker container stops or turns unhealthy",
    unit: "",
    direction: "none",
    min: 1,
    max: 1,
  },
  certificate: {
    label: "Panel certificate expires",
    unit: "days",
    direction: "below",
    min: 1,
    max: 90,
    panel: true,
  },
  certificates: {
    label: "Any managed certificate expires",
    unit: "days",
    direction: "below",
    min: 1,
    max: 90,
    panel: true,
  },
};
export type EmailProvider = "smtp" | "resend" | "postmark";
/**
 * An earlier, lower level on a critical rule. One incident opens as a warning and is raised to
 * critical in place, so a reading past both levels never produces two notifications.
 */
export interface AlertWarningLevel {
  /** In the condition's unit (percent, hours, days, minutes). Unused for yes-or-no conditions. */
  threshold: number;
  durationSeconds: number;
}
export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  metric: AlertMetric;
  threshold: number;
  durationSeconds: number;
  severity: AlertSeverity;
  /** Only on critical rules; null when the rule has a single level. */
  warning: AlertWarningLevel | null;
  nodeIds: string[];
  channelIds: string[];
  recovery: boolean;
  repeatMinutes: number;
}
export interface AlertIncident {
  id: string;
  ruleId: string;
  name: string;
  targetId: string;
  targetName: string;
  severity: AlertSeverity;
  startedAt: number;
  resolvedAt: number | null;
  acknowledgedAt: number | null;
  silencedUntil: number;
  detail: string;
}
export interface EmailSettings {
  provider: EmailProvider;
  from: string;
  to: string[];
  host: string;
  port: number;
  security: "tls" | "starttls";
  username: string;
}
export interface NotificationChannel {
  id: string;
  name: string;
  kind: "telegram" | "email";
  enabled: boolean;
  minimumSeverity: AlertSeverity;
  destination: string;
  email: EmailSettings | null;
  hasSecret: boolean;
  emailMethodId?: string;
  emailMethodName?: string;
}
export interface DeliveryLog {
  id: string;
  channelId: string;
  channelName: string;
  title: string;
  state: "queued" | "sent" | "failed" | "cancelled";
  attempts: number;
  at: number;
  detail: string;
}
export interface TelegramCandidate {
  id: string;
  name: string;
  type: string;
  username: string;
  sender: string;
}
export interface TelegramSetup {
  id: string;
  botName: string;
  url: string;
  command: string;
  expiresAt: number;
  candidates: TelegramCandidate[];
}
export interface AlertsView {
  rules: AlertRule[];
  incidents: AlertIncident[];
  channels: NotificationChannel[];
  deliveries: DeliveryLog[];
  nodes: { id: string; name: string }[];
  /** Rules still exactly as seeded before alpha.41, which the recommended set can replace. */
  legacyDefaults: number;
}
