// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { legacyReleaseChanges } from "./release-details.ts";

describe("legacyReleaseChanges", () => {
  it("turns legacy multiline notes into individual readable rows", () => {
    expect(legacyReleaseChanges("- First fix\n* Second fix\n\nThird fix")).toEqual([
      { kind: "other", title: "First fix" },
      { kind: "other", title: "Second fix" },
      { kind: "other", title: "Third fix" },
    ]);
  });
});
