// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { compareVersions } from "../packages/shared/src/version.ts";

/** Validates compatibility metadata before it can be published or merged. */
export function validateReleasePolicy(value, currentVersion) {
  if (
    !value ||
    typeof value !== "object" ||
    value.schemaVersion !== 1 ||
    !value.downgrade ||
    typeof value.downgrade !== "object" ||
    typeof value.downgrade.supported !== "boolean"
  )
    throw new Error("releases/release-policy.json is invalid.");
  const minimum = value.downgrade.minVersion;
  if (
    (value.downgrade.supported && typeof minimum !== "string") ||
    (!value.downgrade.supported && minimum != null) ||
    (typeof minimum === "string" &&
      (compareVersions(minimum, currentVersion) === null ||
        compareVersions(minimum, currentVersion) >= 0))
  )
    throw new Error(
      "A supported downgrade requires an older semantic minVersion; disabled downgrade must omit it.",
    );
  if (
    !Array.isArray(value.knownIssues) ||
    value.knownIssues.length > 100 ||
    value.knownIssues.some(
      (issue) =>
        !issue ||
        typeof issue !== "object" ||
        typeof issue.title !== "string" ||
        !issue.title.trim() ||
        issue.title.length > 500 ||
        !["low", "medium", "high", "critical"].includes(issue.severity) ||
        (issue.id != null && (typeof issue.id !== "string" || issue.id.length > 80)),
    )
  )
    throw new Error("releases/release-policy.json has invalid known issues.");
  return value;
}
