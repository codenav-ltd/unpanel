// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { en } from "./i18n/en.ts";

const STORAGE_KEY = "unpanel.dashboard.layout";
/** The show/hide map used before cards could be ordered and sized. */
const LEGACY_KEY = "unpanel.dashboard.cards";

/** Widths on a 12-column grid: a quarter, a third, a half and the full row. */
export const cardSizes = ["s", "m", "l", "xl"] as const;
export type CardSize = (typeof cardSizes)[number];

export const sizeLabels: Record<CardSize, string> = {
  s: "S",
  m: "M",
  l: "L",
  xl: "Full",
};

export const sizeNames: Record<CardSize, string> = {
  s: "Quarter width",
  m: "Third width",
  l: "Half width",
  xl: "Full width",
};

interface CardSpec {
  label: string;
  sizes: readonly CardSize[];
  size: CardSize;
}

export const cardCatalog = {
  cpu: { label: en.shell.cpu, sizes: ["s", "m", "l"], size: "s" },
  memory: { label: en.shell.memory, sizes: ["s", "m", "l"], size: "s" },
  swap: { label: en.shell.swap, sizes: ["s", "m", "l"], size: "s" },
  storage: { label: en.shell.storage, sizes: ["s", "m", "l"], size: "s" },
  throughput: { label: en.shell.overallSpeed, sizes: ["m", "l", "xl"], size: "l" },
  connections: { label: en.shell.connections, sizes: ["s", "m", "l"], size: "s" },
  breakdown: { label: en.shell.breakdown, sizes: ["s", "m", "l"], size: "s" },
  docker: { label: "Docker", sizes: ["m", "l", "xl"], size: "l" },
  alerts: { label: "Alerts", sizes: ["m", "l", "xl"], size: "l" },
  uptime: { label: en.shell.uptime, sizes: ["s", "m", "l"], size: "m" },
  processes: { label: en.shell.systemStrip, sizes: ["s", "m", "l"], size: "m" },
  addresses: { label: en.shell.ipAddresses, sizes: ["s", "m", "l"], size: "m" },
} as const satisfies Record<string, CardSpec>;

export type CardId = keyof typeof cardCatalog;
export const cardIds = Object.keys(cardCatalog) as CardId[];

export interface LayoutItem {
  id: CardId;
  size: CardSize;
}

export interface DashboardLayout {
  items: LayoutItem[];
  /** Every card this browser has seen, so a card added in a later release appears once. */
  known: CardId[];
}

function isCardId(value: unknown): value is CardId {
  return typeof value === "string" && Object.hasOwn(cardCatalog, value);
}

export function allowedSizes(id: CardId): readonly CardSize[] {
  return cardCatalog[id].sizes;
}

export function defaultLayout(): DashboardLayout {
  return {
    items: cardIds.map((id) => ({ id, size: cardCatalog[id].size })),
    known: [...cardIds],
  };
}

/** Cards from a later release join at the end, once; a card the user removed stays removed. */
function withNewCards(layout: DashboardLayout): DashboardLayout {
  const missing = cardIds.filter((id) => !layout.known.includes(id));
  if (!missing.length) return layout;
  return {
    items: [...layout.items, ...missing.map((id) => ({ id, size: cardCatalog[id].size }))],
    known: [...layout.known, ...missing],
  };
}

export function parseLayout(raw: string | null): DashboardLayout | null {
  if (!raw) return null;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!stored || typeof stored !== "object") return null;
  const { items, known } = stored as { items?: unknown; known?: unknown };
  if (!Array.isArray(items)) return null;
  const seen = new Set<CardId>();
  const parsed: LayoutItem[] = [];
  for (const item of items) {
    const { id, size } = (item ?? {}) as { id?: unknown; size?: unknown };
    if (!isCardId(id) || seen.has(id)) continue;
    seen.add(id);
    const sizes = allowedSizes(id);
    parsed.push({
      id,
      size: sizes.includes(size as CardSize) ? (size as CardSize) : cardCatalog[id].size,
    });
  }
  const knownIds = Array.isArray(known) ? known.filter(isCardId) : [];
  return withNewCards({ items: parsed, known: [...new Set([...knownIds, ...seen])] });
}

/** The old map only hid cards. `system` was one strip that is now three cards. */
export function migrateLegacy(raw: string | null): DashboardLayout | null {
  if (!raw) return null;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const hidden = new Set<string>(
    Object.entries(stored as Record<string, unknown>)
      .filter(([, value]) => value === false)
      .map(([key]) => key),
  );
  if (hidden.has("system")) ["uptime", "processes", "addresses"].forEach((id) => hidden.add(id));
  const layout = defaultLayout();
  return { ...layout, items: layout.items.filter((item) => !hidden.has(item.id)) };
}

export function loadLayout(storage: Storage = globalThis.localStorage): DashboardLayout {
  try {
    return (
      parseLayout(storage.getItem(STORAGE_KEY)) ??
      migrateLegacy(storage.getItem(LEGACY_KEY)) ??
      defaultLayout()
    );
  } catch {
    return defaultLayout();
  }
}

export function saveLayout(
  layout: DashboardLayout,
  storage: Storage = globalThis.localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // A browser with storage disabled keeps the layout for this page only.
  }
}

export function hiddenCards(layout: DashboardLayout): CardId[] {
  return cardIds.filter((id) => !layout.items.some((item) => item.id === id));
}

export function moveCard(layout: DashboardLayout, id: CardId, to: number): DashboardLayout {
  const from = layout.items.findIndex((item) => item.id === id);
  if (from < 0) return layout;
  const items = [...layout.items];
  const [item] = items.splice(from, 1);
  items.splice(Math.max(0, Math.min(to, items.length)), 0, item as LayoutItem);
  return { ...layout, items };
}

export function resizeCard(layout: DashboardLayout, id: CardId, size: CardSize): DashboardLayout {
  if (!allowedSizes(id).includes(size)) return layout;
  return {
    ...layout,
    items: layout.items.map((item) => (item.id === id ? { ...item, size } : item)),
  };
}

export function removeCard(layout: DashboardLayout, id: CardId): DashboardLayout {
  return { ...layout, items: layout.items.filter((item) => item.id !== id) };
}

export function addCard(layout: DashboardLayout, id: CardId): DashboardLayout {
  if (layout.items.some((item) => item.id === id)) return layout;
  return { ...layout, items: [...layout.items, { id, size: cardCatalog[id].size }] };
}
