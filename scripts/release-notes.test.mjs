// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { releaseMetadata } from "./release-notes.mjs";

describe("releaseMetadata", () => {
  it("turns changelog categories into readable manifest rows", () => {
    const result = releaseMetadata(
      `# Changelog

## [Unreleased]

### Fixed

- Not part of this release.

## [1.2.0] - 2026-10-02

### Added

- Add \`update details\`.

### Fixed

- Fix the [restart check](https://example.com/change).

### Deprecated

- Retire the old update endpoint in the next major release.
`,
      "1.2.0",
    );

    expect(result.changes).toEqual([
      { kind: "feature", title: "Add update details." },
      { kind: "fix", title: "Fix the restart check." },
      {
        kind: "deprecation",
        title: "Retire the old update endpoint in the next major release.",
      },
    ]);
    expect(result.reviewRequired).toBe(false);
    expect(result.markdown).toContain("## New features");
    expect(result.notes).toContain("[Bug fix] Fix the restart check.");
  });

  it("requires review when a release removes behavior", () => {
    const result = releaseMetadata(
      `## [2.0.0]

### Removed

- Remove the legacy enrollment command.
`,
      "2.0.0",
    );

    expect(result.changes).toEqual([
      { kind: "breaking", title: "Remove the legacy enrollment command." },
    ]);
    expect(result.reviewRequired).toBe(true);
  });

  it("refuses to package a release without categorized notes", () => {
    expect(() => releaseMetadata("## [1.0.0]\n", "1.0.0")).toThrow(/no categorized changes/);
    expect(() => releaseMetadata("## [1.0.0]\n", "1.0.1")).toThrow(/no 1.0.1 release section/);
  });
});
