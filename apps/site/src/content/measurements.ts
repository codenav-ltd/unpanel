// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

// Measured on 2026-10-14 with scripts/bench-footprint.sh and scripts/bench-update.sh.
// The multi-server row is from each vendor's own editions, checked in October 2026.
// Change these only with a new benchmark run; see docs/design/11-website.md §3.3.

export const panels = ["Unpanel", "1Panel", "aaPanel", "BaoTa"] as const;
export type Panel = (typeof panels)[number];

export const measuredVersions =
  "Unpanel 0.1.0-alpha.41, 1Panel v2.3.2 without Docker, aaPanel 8.0.7, BaoTa 13.1.0";

/** Counts drawn as one square each in the footprint chart. */
export const footprint = {
  etcFiles: { Unpanel: 7, "1Panel": 4, aaPanel: 397, BaoTa: 397 },
  packages: { Unpanel: 0, "1Panel": 0, aaPanel: 275, BaoTa: 270 },
  /** Megabytes on disk, without the Node.js runtime Unpanel needs. */
  diskMb: { Unpanel: 8, "1Panel": 197, aaPanel: 1843, BaoTa: 1331 },
} satisfies Record<string, Record<Panel, number>>;

export type FootprintMetric = keyof typeof footprint;

/** Megabytes per square in the disk chart. */
export const MB_PER_SQUARE = 10;

export const NODE_RUNTIME_MB = 207;

export const update = {
  seconds: { Unpanel: 1.4, "1Panel": 4.5 },
  downloadMb: { Unpanel: 1.5, "1Panel": 61 },
  offlineSeconds: 0.7,
};

/** The full table. Row labels come from the locale; values are the same everywhere. */
export const measuredRows = [
  { key: "multiServer", values: ["free", "paid", "paid", "paid"] },
  { key: "update", values: ["1.4 s", "4.5 s", "—", "—"] },
  { key: "updateDownload", values: ["1.5 MB", "61 MB", "—", "—"] },
  { key: "updateOffline", values: ["0.7 s", "none", "—", "—"] },
  { key: "install", values: ["34 s", "40 s", "25 min", "14 min"] },
  { key: "packages", values: ["0", "0", "275", "270"] },
  { key: "etc", values: ["7", "4", "397", "397"] },
  { key: "disk", values: ["8 MB", "197 MB", "1.8 GB", "1.3 GB"] },
  { key: "root", values: ["1 / 2", "2 / 2", "4 / 5", "4 / 4"] },
  { key: "memory", values: ["140 MB", "138 MB", "94 MB", "74 MB"] },
] as const;

export type MeasuredRow = (typeof measuredRows)[number]["key"];
