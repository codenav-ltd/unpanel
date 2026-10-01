// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { coreColumns } from "./core-columns.ts";

describe("coreColumns", () => {
  it("picks a square when the count divides evenly", () => {
    expect(coreColumns(16)).toBe(4);
    expect(coreColumns(4)).toBe(2);
    expect(coreColumns(1)).toBe(1);
  });

  it("prefers a wide rectangle over a tall one", () => {
    expect(coreColumns(8)).toBe(4);
    expect(coreColumns(12)).toBe(4);
    expect(coreColumns(6)).toBe(3);
  });
});
