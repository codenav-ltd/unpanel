// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { en } from "./i18n/en.ts";

const STORAGE_KEY = "unpanel.dashboard.cards";

export const cardIds = [
  "cpu",
  "memory",
  "swap",
  "storage",
  "breakdown",
  "throughput",
  "connections",
  "system",
] as const;

export type CardId = (typeof cardIds)[number];

export type CardVisibility = Record<CardId, boolean>;

export const cardLabels: Record<CardId, string> = {
  cpu: en.shell.cpu,
  memory: en.shell.memory,
  swap: en.shell.swap,
  storage: en.shell.storage,
  breakdown: en.shell.breakdown,
  throughput: en.shell.overallSpeed,
  connections: en.shell.connections,
  system: en.shell.systemCard,
};

export function defaultCards(): CardVisibility {
  return Object.fromEntries(cardIds.map((id) => [id, true])) as CardVisibility;
}

/** Unknown and missing keys fall back to visible, so a new card shows up after an upgrade. */
export function parseCards(raw: string | null): CardVisibility {
  const cards = defaultCards();
  if (!raw) return cards;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return cards;
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return cards;
  for (const id of cardIds) {
    const value = (stored as Record<string, unknown>)[id];
    if (typeof value === "boolean") cards[id] = value;
  }
  return cards;
}

export function loadCards(): CardVisibility {
  try {
    return parseCards(globalThis.localStorage.getItem(STORAGE_KEY));
  } catch {
    return defaultCards();
  }
}

export function saveCards(cards: CardVisibility): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
  } catch {
    // A browser with storage disabled keeps the choice for this page only.
  }
}
