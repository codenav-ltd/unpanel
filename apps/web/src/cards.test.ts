// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { cardIds, defaultCards, parseCards } from "./cards.ts";

describe("parseCards", () => {
  it("shows every card when nothing was stored", () => {
    expect(parseCards(null)).toEqual(defaultCards());
    expect(Object.values(parseCards(null)).every(Boolean)).toBe(true);
  });

  it("keeps the stored choice and defaults the rest to visible", () => {
    const cards = parseCards(JSON.stringify({ swap: false, breakdown: false }));

    expect(cards.swap).toBe(false);
    expect(cards.breakdown).toBe(false);
    expect(cards.cpu).toBe(true);
  });

  it("ignores junk, wrong types, and unknown keys", () => {
    expect(parseCards("not json")).toEqual(defaultCards());
    expect(parseCards("[1,2]")).toEqual(defaultCards());
    expect(parseCards(JSON.stringify({ cpu: "no", bogus: false }))).toEqual(defaultCards());
  });

  it("covers every card id", () => {
    expect(Object.keys(defaultCards()).sort()).toEqual([...cardIds].sort());
  });
});
