// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { firstSentence, parseReleases } from "./changelog";

const sample = `# Changelog

## [Unreleased]

## [0.1.0-alpha.48] - 2026-10-18

### Added

- Remote servers follow a new panel address. Saving it in Settings sends it.

## [0.1.0-alpha.47] - 2026-10-18

### Changed

- The server command is now \`unpanel\`: \`sudo unpanel restart\`.
`;

describe("parseReleases", () => {
  it("reads versions, dates and the first sentence, skipping Unreleased", () => {
    expect(parseReleases(sample)).toEqual([
      {
        version: "0.1.0-alpha.48",
        date: "2026-10-18",
        summary: "Remote servers follow a new panel address.",
      },
      {
        version: "0.1.0-alpha.47",
        date: "2026-10-18",
        summary: "The server command is now unpanel: sudo unpanel restart.",
      },
    ]);
  });

  it("reads every release in the repository's changelog", () => {
    const changelog = readFileSync(new URL("../../../../CHANGELOG.md", import.meta.url), "utf8");
    const releases = parseReleases(changelog);
    expect(releases.length).toBeGreaterThan(40);
    expect(releases.every((release) => release.summary.length > 0)).toBe(true);
  });
});

describe("firstSentence", () => {
  it("keeps abbreviations and decimals inside the sentence", () => {
    expect(firstSentence("Downloads 1.5 MB, e.g. from the mirror. Then more.")).toBe(
      "Downloads 1.5 MB, e.g. from the mirror.",
    );
  });

  it("shortens long sentences at a word boundary", () => {
    const long = `${"word ".repeat(60)}end.`;
    const result = firstSentence(long);
    expect(result.length).toBeLessThanOrEqual(140);
    expect(result.endsWith("word…")).toBe(true);
  });
});
