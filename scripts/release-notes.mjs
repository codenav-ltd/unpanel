// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

const HEADING_KINDS = new Map([
  ["added", "feature"],
  ["changed", "improvement"],
  ["fixed", "fix"],
  ["security", "security"],
  ["critical", "critical"],
  ["deprecated", "deprecation"],
  ["removed", "breaking"],
]);

const KIND_LABELS = {
  feature: "New feature",
  improvement: "Improvement",
  fix: "Bug fix",
  security: "Security",
  critical: "Critical",
  deprecation: "Deprecated",
  breaking: "Breaking change",
};

const KIND_HEADINGS = {
  feature: "New features",
  improvement: "Improvements",
  fix: "Bug fixes",
  security: "Security",
  critical: "Critical",
  deprecation: "Deprecations",
  breaking: "Breaking changes",
};

/** Panels before alpha.45 drop longer entries from update details instead of showing them. */
export const MAX_CHANGE_LENGTH = 500;

const KIND_ORDER = [
  "critical",
  "breaking",
  "security",
  "deprecation",
  "feature",
  "improvement",
  "fix",
];

/** Turn one Keep a Changelog release section into the update manifest payload. */
export function releaseMetadata(changelog, version) {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const changes = [];
  let foundRelease = false;
  let insideRelease = false;
  let kind = null;

  for (const line of lines) {
    const release = line.match(/^## \[([^\]]+)\](?:\s+-\s+.+)?\s*$/);
    if (release) {
      if (insideRelease) break;
      insideRelease = release[1] === version;
      foundRelease ||= insideRelease;
      kind = null;
      continue;
    }
    if (!insideRelease) continue;

    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      kind = HEADING_KINDS.get(heading[1].trim().toLowerCase()) ?? null;
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+?)\s*$/);
    if (!bullet || !kind) continue;
    const title = plainText(bullet[1]);
    if (title.length > MAX_CHANGE_LENGTH)
      throw new Error(
        `A ${version} changelog entry has ${title.length} characters; split it into entries of at most ${MAX_CHANGE_LENGTH}: "${title.slice(0, 60)}…"`,
      );
    if (title) changes.push({ kind, title });
  }

  if (!foundRelease) throw new Error(`CHANGELOG.md has no ${version} release section.`);
  if (changes.length === 0)
    throw new Error(`CHANGELOG.md has no categorized changes for ${version}.`);

  const notes = changes.map((change) => `[${KIND_LABELS[change.kind]}] ${change.title}`).join("\n");
  return {
    changes,
    notes,
    reviewRequired: changes.some((change) => change.kind === "breaking"),
    markdown: markdownReleaseNotes(version, changes),
  };
}

export function markdownReleaseNotes(version, changes) {
  const sections = [`# Unpanel v${version}`];
  for (const kind of KIND_ORDER) {
    const rows = changes.filter((change) => change.kind === kind);
    if (rows.length === 0) continue;
    sections.push(`## ${KIND_HEADINGS[kind]}`, rows.map((row) => `- ${row.title}`).join("\n"));
  }
  return `${sections.join("\n\n")}\n`;
}

/** Drops Markdown markup but keeps literal text such as `UNPANEL_FILES_ALLOW` intact. */
export function plainText(value) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|~~)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}
