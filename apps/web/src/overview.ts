// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { loadLevel } from "./theme/thresholds.ts";

/** The fields the overview reads from a node; the catalog row carries more. */
export interface OverviewNode {
  name: string;
  hostname: string | null;
  status: "pending" | "active" | "disabled";
  online: boolean;
  cpuRatio: number | null;
  memRatio: number | null;
  diskRatio: number | null;
}

export type Attention = "offline" | "danger" | "warn" | "ok" | "pending" | "disabled";

const rank: Record<Attention, number> = {
  offline: 0,
  danger: 1,
  warn: 2,
  ok: 3,
  pending: 4,
  disabled: 5,
};

/** How urgently a node needs a look, and the readings that make it so, worst first. */
export function attention(node: OverviewNode): { level: Attention; reasons: string[] } {
  if (node.status === "disabled") return { level: "disabled", reasons: [] };
  if (node.status === "pending") return { level: "pending", reasons: [] };
  if (!node.online) return { level: "offline", reasons: ["Offline"] };
  const candidates: { label: string; ratio: number | null }[] = [
    { label: "CPU", ratio: node.cpuRatio },
    { label: "Memory", ratio: node.memRatio },
    { label: "Storage", ratio: node.diskRatio },
  ];
  const readings = candidates
    .flatMap(({ label, ratio }) =>
      ratio == null ? [] : [{ label, ratio, level: loadLevel(ratio) }],
    )
    .filter((reading) => reading.level !== "primary")
    .sort((a, b) => b.ratio - a.ratio);
  const level = readings.some((reading) => reading.level === "danger")
    ? "danger"
    : readings.length
      ? "warn"
      : "ok";
  return {
    level,
    reasons: readings.map((reading) => `${reading.label} ${Math.round(reading.ratio * 100)}%`),
  };
}

/** Nodes that need a look first; equal nodes keep a stable alphabetical order. */
export function sortForOverview<T extends OverviewNode>(nodes: readonly T[]): T[] {
  const label = (node: T) => node.name || node.hostname || "";
  return [...nodes].sort(
    (a, b) =>
      rank[attention(a).level] - rank[attention(b).level] || label(a).localeCompare(label(b)),
  );
}

export function needsAttention(node: OverviewNode): boolean {
  const level = attention(node).level;
  return level === "offline" || level === "danger" || level === "warn";
}
