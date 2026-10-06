// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export interface UpdateStep {
  name: string;
  durationMs: number;
  downtime: boolean;
}

export interface UpdateOperation {
  id: string;
  operation: "update" | "downgrade";
  from: string;
  to: string;
  startedAt: string;
  status: "running" | "succeeded" | "rolled-back" | "failed";
  durationMs: number | null;
  downtimeMs: number | null;
  steps: UpdateStep[];
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${ms} ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function stepLabel(name: string): string {
  return name.replace(/-/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}
