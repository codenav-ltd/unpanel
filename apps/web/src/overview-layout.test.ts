// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { parseOverviewLayout } from "./overview-layout.ts";

describe("parseOverviewLayout", () => {
  it("keeps the detailed cards when nothing was stored", () => {
    expect(parseOverviewLayout(null)).toBe("detail");
    expect(parseOverviewLayout("")).toBe("detail");
  });

  it("accepts the three sizes and ignores anything else", () => {
    expect(parseOverviewLayout("compact")).toBe("compact");
    expect(parseOverviewLayout("standard")).toBe("standard");
    expect(parseOverviewLayout("detail")).toBe("detail");
    expect(parseOverviewLayout("large")).toBe("detail");
  });
});
