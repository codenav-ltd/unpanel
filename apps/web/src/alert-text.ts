// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { AlertRule } from "@unpanel/shared";

/** 120 → "2 min", 90 → "90 s", 7200 → "2 h". */
export function humanDuration(seconds: number): string {
  if (seconds < 60 || seconds % 60) return `${seconds} s`;
  const minutes = seconds / 60;
  if (minutes < 60 || minutes % 60) return `${minutes} min`;
  return `${minutes / 60} h`;
}

const METRIC: Record<AlertRule["metric"], string> = {
  offline: "Node offline",
  cpu: "CPU",
  memory: "Memory",
  disk: "System disk",
  swap: "Swap",
  certificate: "Panel certificate",
};

/** One line a person reads as the rule: "Memory ≥ 95% for 5 min". */
export function ruleCondition(
  rule: Pick<AlertRule, "metric" | "threshold" | "durationSeconds">,
): string {
  const wait = rule.durationSeconds ? ` for ${humanDuration(rule.durationSeconds)}` : "";
  if (rule.metric === "offline") return `${METRIC.offline}${wait}`;
  if (rule.metric === "certificate")
    return `${METRIC.certificate} expires within ${rule.threshold} ${rule.threshold === 1 ? "day" : "days"}`;
  return `${METRIC[rule.metric]} ≥ ${rule.threshold}%${wait}`;
}

export function ruleScope(
  rule: Pick<AlertRule, "metric" | "nodeIds">,
  nodes: readonly { id: string; name: string }[],
): string {
  if (rule.metric === "certificate") return "This panel";
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
