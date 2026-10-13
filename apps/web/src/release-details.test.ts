// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { downgradeImpact, legacyReleaseChanges, type ReleaseOption } from "./release-details.ts";

describe("legacyReleaseChanges", () => {
  it("turns legacy multiline notes into individual readable rows", () => {
    expect(legacyReleaseChanges("- First fix\n* Second fix\n\nThird fix")).toEqual([
      { kind: "other", title: "First fix" },
      { kind: "other", title: "Second fix" },
      { kind: "other", title: "Third fix" },
    ]);
  });
});

describe("downgradeImpact", () => {
  const option = (
    reverted: ReleaseOption["reverted"],
    exposedTo: ReleaseOption["exposedTo"] = [],
  ) =>
    ({
      version: "0.1.0-alpha.36",
      available: true,
      reason: null,
      notes: "",
      changelog: [],
      knownIssues: [],
      lostFeatures: [],
      reverted,
      exposedTo,
      reviewRequired: true,
    }) satisfies ReleaseOption;

  it("puts security fixes apart and groups the rest by kind", () => {
    const impact = downgradeImpact(
      option([
        { kind: "fix", title: "Fix A", version: "0.1.0-alpha.38" },
        { kind: "security", title: "Patch B", version: "0.1.0-alpha.38" },
        { kind: "feature", title: "Feature C", version: "0.1.0-alpha.37" },
        { kind: "critical", title: "Patch D", version: "0.1.0-alpha.37" },
      ]),
    );
    expect(impact.total).toBe(4);
    expect(impact.releases).toBe(2);
    expect(impact.securityFixes.map((change) => change.title)).toEqual(["Patch B", "Patch D"]);
    expect(impact.groups.map((group) => group.kind)).toEqual(["feature", "fix"]);
  });

  it("reports nothing to undo for an empty history", () => {
    const impact = downgradeImpact(option([]));
    expect(impact).toMatchObject({ total: 0, releases: 0, securityFixes: [], groups: [] });
  });
});
