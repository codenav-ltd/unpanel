// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

const STORAGE_KEY = "unpanel.overview.layout";

export const overviewLayouts = ["compact", "standard", "detail"] as const;

export type OverviewLayout = (typeof overviewLayouts)[number];

export function parseOverviewLayout(raw: string | null): OverviewLayout {
  if (raw === "compact" || raw === "standard" || raw === "detail") return raw;
  return "detail";
}

export function loadOverviewLayout(): OverviewLayout {
  try {
    return parseOverviewLayout(globalThis.localStorage.getItem(STORAGE_KEY));
  } catch {
    return "detail";
  }
}

export function saveOverviewLayout(layout: OverviewLayout): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, layout);
  } catch {
    // A browser with storage disabled keeps the choice for this page only.
  }
}
