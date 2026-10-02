// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { compareVersions } from "./version.ts";

describe("compareVersions", () => {
  it("orders stable and prerelease versions", () => {
    expect(compareVersions("0.1.0-alpha.16", "0.1.0-alpha.17")).toBeLessThan(0);
    expect(compareVersions("v1.0.0", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("rejects strings that are not product versions", () => {
    expect(compareVersions("dev", "1.0.0")).toBeNull();
  });
});
