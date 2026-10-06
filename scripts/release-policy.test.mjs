// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { validateReleasePolicy } from "./release-policy.mjs";

describe("release compatibility policy", () => {
  it("accepts disabled downgrade and a bounded supported range", () => {
    expect(
      validateReleasePolicy(
        { schemaVersion: 1, downgrade: { supported: false }, knownIssues: [] },
        "1.2.0",
      ),
    ).toBeTruthy();
    expect(
      validateReleasePolicy(
        {
          schemaVersion: 1,
          downgrade: { supported: true, minVersion: "1.1.0" },
          knownIssues: [{ id: "#1", severity: "medium", title: "Fixture" }],
        },
        "1.2.0",
      ),
    ).toBeTruthy();
  });

  it("rejects unbounded downgrade and malformed known issues", () => {
    expect(() =>
      validateReleasePolicy(
        { schemaVersion: 1, downgrade: { supported: true }, knownIssues: [] },
        "1.2.0",
      ),
    ).toThrow(/minVersion/);
    expect(() =>
      validateReleasePolicy(
        {
          schemaVersion: 1,
          downgrade: { supported: false },
          knownIssues: [{ severity: "urgent", title: "Fixture" }],
        },
        "1.2.0",
      ),
    ).toThrow(/known issues/);
  });
});
