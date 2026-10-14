// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export interface ContainerRow {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
}

export type ContainerHealth = "failing" | "stopped" | "running" | "other";

export interface DockerSummary {
  running: number;
  stopped: number;
  failing: number;
  total: number;
  /** Containers worth a look first: failing, then stopped, then running. */
  rows: { id: string; name: string; image: string; status: string; health: ContainerHealth }[];
}

const RANK: Record<ContainerHealth, number> = { failing: 0, stopped: 1, other: 2, running: 3 };

/** Restarting, dead, unhealthy and non-zero exits need attention; a clean exit is just stopped. */
export function containerHealth(row: ContainerRow): ContainerHealth {
  const exitCode = /^Exited \((\d+)\)/.exec(row.Status)?.[1];
  if (
    row.State === "restarting" ||
    row.State === "dead" ||
    row.Status.includes("(unhealthy)") ||
    (exitCode !== undefined && exitCode !== "0")
  )
    return "failing";
  if (row.State === "running") return "running";
  if (row.State === "exited" || row.State === "created") return "stopped";
  return "other";
}

export function summarizeContainers(rows: readonly ContainerRow[], limit = 5): DockerSummary {
  const ranked = rows
    .map((row) => ({
      id: row.Id,
      name: row.Names[0]?.replace(/^\//, "") || row.Id.slice(0, 12),
      image: row.Image,
      status: row.Status,
      health: containerHealth(row),
    }))
    .sort((a, b) => RANK[a.health] - RANK[b.health] || a.name.localeCompare(b.name));
  return {
    running: rows.filter((row) => row.State === "running").length,
    stopped: ranked.filter((row) => row.health === "stopped").length,
    failing: ranked.filter((row) => row.health === "failing").length,
    total: rows.length,
    rows: ranked.slice(0, limit),
  };
}
