// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { formatHistoryTime, hoverIndex } from "./history-time.ts";

describe("history time", () => {
  it("maps the pointer across the samples", () => {
    expect(hoverIndex(0, 100, 5)).toBe(0);
    expect(hoverIndex(100, 100, 5)).toBe(4);
    expect(hoverIndex(50, 100, 5)).toBe(2);
    expect(hoverIndex(-10, 100, 5)).toBe(0);
  });

  it("prints a clock for an hour and a date for a week", () => {
    const at = Date.UTC(2026, 9, 2, 4, 15);
    expect(formatHistoryTime(at, 60 * 60 * 1000, "UTC")).toBe("04:15");
    expect(formatHistoryTime(at, 7 * 24 * 60 * 60 * 1000, "UTC")).toBe("2 Oct, 04:15");
  });
});
