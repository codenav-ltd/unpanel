// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { ALERT_METRICS, type AlertRule } from "@unpanel/shared";

/** 120 → "2 min", 90 → "90 s", 7200 → "2 h". */
export function humanDuration(seconds: number): string {
  if (seconds < 60 || seconds % 60) return `${seconds} s`;
  const minutes = seconds / 60;
  if (minutes < 60 || minutes % 60) return `${minutes} min`;
  return `${minutes / 60} h`;
}

const SHORT: Record<AlertRule["metric"], string> = {
  offline: "Node offline",
  cpu: "CPU",
  memory: "Memory",
  disk: "System disk",
  disk_forecast: "System disk",
  inodes: "Disk inodes",
  swap: "Swap",
  load: "Load per core",
  network_in: "Inbound traffic",
  network_out: "Outbound traffic",
  connections: "TCP connections",
  restarted: "Server restarted",
  container: "Container down",
  certificate: "Panel certificate",
  certificates: "Managed certificates",
};

/** "90%", "500 Mbit/s", "5,000", "7 days". */
export function amount(metric: AlertRule["metric"], value: number): string {
  const unit = ALERT_METRICS[metric].unit;
  if (unit === "%") return `${value}%`;
  if (unit === "Mbit/s") return `${value} Mbit/s`;
  if (unit === "days") return `${value} ${value === 1 ? "day" : "days"}`;
  if (unit === "min") return `${value} min`;
  if (unit === "hours") return `${value} ${value === 1 ? "hour" : "hours"}`;
  return value.toLocaleString("en-US");
}

function after(seconds: number): string {
  return seconds ? ` for ${humanDuration(seconds)}` : "";
}

/**
 * One line a person reads as the rule: "Memory ≥ 95% for 5 min", or with an earlier warning
 * "Memory: warning ≥ 80% for 5 min, critical ≥ 90% for 3 min".
 */
export function ruleCondition(
  rule: Pick<AlertRule, "metric" | "threshold" | "durationSeconds"> &
    Partial<Pick<AlertRule, "warning">>,
): string {
  const warning = rule.warning ?? null;
  const name = SHORT[rule.metric];
  if (ALERT_METRICS[rule.metric].direction === "none")
    return warning
      ? `${name}: warning ${warning.durationSeconds ? `after ${humanDuration(warning.durationSeconds)}` : "immediately"}, critical after ${humanDuration(rule.durationSeconds)}`
      : `${name}${after(rule.durationSeconds)}`;
  if (rule.metric === "restarted") return `${name} (up less than ${rule.threshold} min)`;
  if (rule.metric === "disk_forecast")
    return warning
      ? `${name} full within: warning ${amount(rule.metric, warning.threshold)}, critical ${amount(rule.metric, rule.threshold)}`
      : `${name} full within ${amount(rule.metric, rule.threshold)}`;
  if (ALERT_METRICS[rule.metric].unit === "days")
    return warning
      ? `${name}: warning at ${amount(rule.metric, warning.threshold)} left, critical at ${amount(rule.metric, rule.threshold)}`
      : `${rule.metric === "certificates" ? "Any managed certificate" : name} expires within ${amount(rule.metric, rule.threshold)}`;
  return warning
    ? `${name}: warning ≥ ${amount(rule.metric, warning.threshold)}${after(warning.durationSeconds)}, critical ≥ ${amount(rule.metric, rule.threshold)}${after(rule.durationSeconds)}`
    : `${name} ≥ ${amount(rule.metric, rule.threshold)}${after(rule.durationSeconds)}`;
}

/** The node an incident is about: the target itself, or the node a container runs on. */
export function incidentNode(targetId: string): { nodeId: string; href: string } {
  const [nodeId = targetId, container] = targetId.split(":container:");
  const base = `/nodes/${encodeURIComponent(nodeId)}`;
  return { nodeId, href: container === undefined ? base : `${base}/docker` };
}

export function ruleScope(
  rule: Pick<AlertRule, "metric" | "nodeIds">,
  nodes: readonly { id: string; name: string }[],
): string {
  if (rule.metric === "certificate") return "This panel";
  if (rule.metric === "certificates") return "All managed certificates";
  if (!rule.nodeIds.length) return "All nodes";
  if (rule.nodeIds.length === 1)
    return nodes.find((node) => node.id === rule.nodeIds[0])?.name ?? "1 node";
  return `${rule.nodeIds.length} nodes`;
}

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
export function timeAgo(at: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
