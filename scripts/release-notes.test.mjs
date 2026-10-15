// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { product } from "../packages/shared/src/product.ts";
import { MAX_CHANGE_LENGTH, plainText, releaseMetadata } from "./release-notes.mjs";

describe("releaseMetadata", () => {
  it("can package the current product version's actual changelog", () => {
    const result = releaseMetadata(readFileSync("CHANGELOG.md", "utf8"), product.version);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.markdown).toContain(`# Unpanel v${product.version}`);
  });
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

describe("plainText", () => {
  it("drops markup but keeps names with underscores and stars", () => {
    expect(plainText("Set `UNPANEL_FILES_ALLOW` in **agent.env**, see _docs_.")).toBe(
      "Set UNPANEL_FILES_ALLOW in agent.env, see docs.",
    );
    expect(plainText("Globs like /srv/*.conf and snake_case stay.")).toBe(
      "Globs like /srv/*.conf and snake_case stay.",
    );
  });
});

describe("entry length", () => {
  it("refuses entries that older panels would hide", () => {
    const long = "x".repeat(MAX_CHANGE_LENGTH + 1);
    expect(() =>
      releaseMetadata(`## [1.0.0] - 2026-10-02\n\n### Added\n\n- ${long}\n`, "1.0.0"),
    ).toThrow(/split it/);
  });
});
