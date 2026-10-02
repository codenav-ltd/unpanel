// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export type AlertSeverity = "warning" | "critical";
export type AlertMetric = "offline" | "cpu" | "memory" | "disk" | "swap" | "certificate";
export type EmailProvider = "smtp" | "resend" | "postmark";
export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  metric: AlertMetric;
  threshold: number;
  durationSeconds: number;
  severity: AlertSeverity;
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
}
