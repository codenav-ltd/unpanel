// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** Load color scale for CPU, memory, and disk. Ratios are 0–1. */
export const loadThresholds = {
  warn: 0.6,
  danger: 0.85,
} as const;

export type LoadLevel = "primary" | "warn" | "danger";

export function loadLevel(ratio: number): LoadLevel {
  if (ratio >= loadThresholds.danger) return "danger";
  if (ratio >= loadThresholds.warn) return "warn";
  return "primary";
}
