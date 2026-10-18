// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

// Footprint measured on 2026-10-18 with scripts/bench-footprint/run-docker.sh; updates on
// 2026-10-14 with scripts/bench-update.sh. Vendor facts were checked on 2026-10-18 against
// the pages in `sources` and the installed code. Change these only with a new run or a new
// check; see docs/design/11-website.md §3.3.

export const panels = ["Unpanel", "1Panel", "aaPanel", "BaoTa"] as const;
export type Panel = (typeof panels)[number];

export const measuredVersions =
  "Unpanel 0.1.0-alpha.48, 1Panel v2.3.2 without Docker, aaPanel 8.0.7, BaoTa 13.1.0";

/** Values drawn as squares in the footprint chart, in tab order. */
export const footprint = {
  /**
   * Megabytes on disk. Unpanel's own files only; its runtime is `RUNTIME_MB` and is drawn
   * beside it. 1Panel excludes the 238 MB installer archive it leaves in the working directory.
   */
  diskMb: { Unpanel: 9, "1Panel": 205, aaPanel: 1699, BaoTa: 1225 },
  packages: { Unpanel: 0, "1Panel": 0, aaPanel: 304, BaoTa: 270 },
  etcFiles: { Unpanel: 7, "1Panel": 4, aaPanel: 421, BaoTa: 397 },
} satisfies Record<string, Record<Panel, number>>;

export type FootprintMetric = keyof typeof footprint;

/** Megabytes per square in the disk chart. */
export const MB_PER_SQUARE = 10;

/** Node.js 24, which Unpanel runs on, as installed under /usr/local. */
export const RUNTIME_MB = 203;

export const update = {
  seconds: { Unpanel: 1.4, "1Panel": 4.5 },
  downloadMb: { Unpanel: 1.5, "1Panel": 61 },
  offlineSeconds: 0.7,
};

/** Where each vendor fact on the page comes from. Labels come from the locale. */
export const sources = [
  { key: "onePanelEditions", url: "https://github.com/1Panel-dev/1Panel#readme" },
  { key: "onePanelNodes", url: "https://1panel.pro/docs/v2/user_manual/xpack/node/" },
  { key: "baotaPricing", url: "https://www.bt.cn/new/pricing.html" },
  { key: "aapanelLicence", url: "https://github.com/aaPanel/aaPanel/blob/master/license.txt" },
] as const;

export type SourceKey = (typeof sources)[number]["key"];

/**
 * The comparison table. Row labels come from the locale; a value that is a key of the
 * locale's `compare.values` is translated, anything else is shown as written.
 */
export const comparison = [
  {
    group: "cost",
    rows: [
      { key: "multiServer", values: ["free", "paidPerNode", "free", "free"] },
      { key: "licence", values: ["AGPL-3.0", "GPL-3.0", "ownNoPublish", "proprietary"] },
    ],
  },
  {
    group: "servers",
    rows: [
      { key: "nodeRuns", values: ["agent", "agent", "fullPanel", "fullPanel"] },
      { key: "nodePorts", values: ["none", "sshAgentPort", "panelOrSsh", "panelOrSsh"] },
      { key: "nat", values: ["yes", "no", "no", "no"] },
    ],
  },
  {
    group: "footprint",
    rows: [
      { key: "install", values: ["27 s", "78 s", "15 min", "13 min"] },
      { key: "packages", values: ["0", "0", "304", "270"] },
      { key: "etc", values: ["7", "4", "421", "397"] },
      { key: "disk", values: ["9 MB", "205 MB", "1.7 GB", "1.2 GB"] },
    ],
  },
  {
    group: "privileges",
    rows: [{ key: "root", values: ["1 / 2", "2 / 2", "4 / 5", "4 / 4"] }],
  },
  {
    group: "updates",
    rows: [
      { key: "update", values: ["1.4 s", "4.5 s", "—", "—"] },
      { key: "updateDownload", values: ["1.5 MB", "61 MB", "—", "—"] },
      { key: "updateOffline", values: ["0.7 s", "noneSeen", "—", "—"] },
    ],
  },
  {
    group: "idle",
    rows: [{ key: "memory", values: ["132 MB", "144 MB", "96 MB", "72 MB"] }],
  },
] as const;

export type CompareGroup = (typeof comparison)[number]["group"];
export type CompareRow = (typeof comparison)[number]["rows"][number]["key"];
