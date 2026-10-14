// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import {
  addCard,
  cardIds,
  defaultLayout,
  hiddenCards,
  loadLayout,
  migrateLegacy,
  moveCard,
  parseLayout,
  removeCard,
  resizeCard,
  saveLayout,
} from "./dashboard-layout.ts";

function memoryStorage(entries: Record<string, string> = {}): Storage {
  const items = new Map(Object.entries(entries));
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

describe("dashboard layout", () => {
  it("starts with every card at its default size", () => {
    const layout = defaultLayout();
    expect(layout.items.map((item) => item.id)).toEqual(cardIds);
    expect(hiddenCards(layout)).toEqual([]);
  });

  it("round-trips order, sizes and removed cards", () => {
    const storage = memoryStorage();
    let layout = moveCard(defaultLayout(), "docker", 0);
    layout = resizeCard(layout, "cpu", "l");
    layout = removeCard(layout, "swap");
    saveLayout(layout, storage);
    const loaded = loadLayout(storage);
    expect(loaded.items[0]).toEqual({ id: "docker", size: "l" });
    expect(loaded.items.find((item) => item.id === "cpu")?.size).toBe("l");
    expect(hiddenCards(loaded)).toEqual(["swap"]);
  });

  it("refuses sizes a card does not allow and drops junk", () => {
    expect(resizeCard(defaultLayout(), "cpu", "xl")).toEqual(defaultLayout());
    const parsed = parseLayout(
      JSON.stringify({
        items: [
          { id: "cpu", size: "xl" },
          { id: "bogus", size: "s" },
          { id: "cpu", size: "m" },
        ],
        known: [...cardIds, "bogus"],
      }),
    );
    expect(parsed?.items).toEqual([{ id: "cpu", size: "s" }]);
    expect(parseLayout("not json")).toBeNull();
    expect(parseLayout(JSON.stringify({ items: "x" }))).toBeNull();
  });

  it("adds a card from a later release once, and keeps a removed card removed", () => {
    const known = cardIds.filter((id) => id !== "alerts");
    const parsed = parseLayout(JSON.stringify({ items: [{ id: "cpu", size: "s" }], known }));
    if (!parsed) throw new Error("layout did not parse");
    expect(parsed.items.map((item) => item.id)).toEqual(["cpu", "alerts"]);
    const removed = removeCard(parsed, "alerts");
    expect(parseLayout(JSON.stringify(removed))?.items.map((item) => item.id)).toEqual(["cpu"]);
  });

  it("migrates the old show/hide map, splitting the system strip", () => {
    const layout = migrateLegacy(JSON.stringify({ swap: false, system: false, cpu: true }));
    if (!layout) throw new Error("legacy map did not migrate");
    expect(hiddenCards(layout)).toEqual(["swap", "uptime", "processes", "addresses"]);
    expect(
      loadLayout(memoryStorage({ "unpanel.dashboard.cards": '{"bogus":false}' })).items,
    ).toHaveLength(cardIds.length);
  });

  it("moves within bounds and adds removed cards back at the end", () => {
    const moved = moveCard(defaultLayout(), "cpu", 99);
    expect(moved.items.at(-1)?.id).toBe("cpu");
    const back = addCard(removeCard(defaultLayout(), "memory"), "memory");
    expect(back.items.at(-1)).toEqual({ id: "memory", size: "s" });
    expect(addCard(back, "memory")).toBe(back);
  });
});
