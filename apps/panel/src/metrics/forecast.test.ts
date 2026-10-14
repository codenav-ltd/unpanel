// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { NOT_FILLING, hoursUntilFull } from "./forecast.ts";

/** One reading a minute, rising by `perHour` from `start`. */
function rising(minutes: number, start: number, perHour: number): (number | null)[] {
  return Array.from({ length: minutes }, (_, minute) => start + (perHour * minute) / 60);
}

describe("hoursUntilFull", () => {
  it("projects the recent rate forward", () => {
    // 2 points an hour for 6 hours, ending at 80%: 20 points left is 10 hours.
    const series = rising(360, 0.68, 0.02);
    expect(hoursUntilFull(series)).toBeCloseTo(10, 0);
  });

  it("waits for two hours of readings", () => {
    expect(hoursUntilFull(rising(100, 0.5, 0.05))).toBeNull();
    const sparse: (number | null)[] = rising(360, 0.5, 0.05).map((value, minute) =>
      minute % 3 ? null : value,
    );
    expect(hoursUntilFull(sparse)).toBeCloseTo((1 - (sparse.at(-3) ?? 0)) / 0.05, 0);
  });

  it("reports flat or shrinking usage as not filling", () => {
    expect(hoursUntilFull(rising(360, 0.9, 0))).toBe(NOT_FILLING);
    expect(hoursUntilFull(rising(360, 0.9, -0.01))).toBe(NOT_FILLING);
  });

  it("ignores gaps and reports a full disk as zero hours", () => {
    const series = rising(360, 0.99, 0.01).map((value) => Math.min(1, value ?? 0));
    expect(hoursUntilFull(series)).toBe(0);
    const gappy = rising(360, 0.5, 0.01);
    gappy.fill(null, 100, 200);
    expect(hoursUntilFull(gappy)).toBeGreaterThan(40);
  });
});
