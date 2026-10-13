// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export type ReleaseChangeKind =
  | "feature"
  | "improvement"
  | "fix"
  | "security"
  | "critical"
  | "deprecation"
  | "breaking"
  | "other";

export interface ReleaseChange {
  kind: ReleaseChangeKind;
  title: string;
}

export interface KnownIssue {
  id?: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
}

export interface ReleaseOption {
  version: string;
  publishedAt?: string;
  available: boolean;
  reason: string | null;
  notes: string;
  changelog: ReleaseChange[];
  knownIssues: KnownIssue[];
  lostFeatures: string[];
  /** For an older release: every change shipped after it, up to and including the installed one. */
  reverted: (ReleaseChange & { version: string })[];
  /** Published advisories that affect this release. */
  exposedTo: { id: string; title: string; severity: string; fixedVersion: string }[];
  reviewRequired: boolean;
}

type Reverted = ReleaseOption["reverted"][number];

const groupOrder: { kind: ReleaseChangeKind; label: string }[] = [
  { kind: "breaking", label: "Breaking changes undone" },
  { kind: "feature", label: "Features you lose" },
  { kind: "improvement", label: "Improvements you lose" },
  { kind: "fix", label: "Bug fixes you lose" },
  { kind: "deprecation", label: "Deprecations undone" },
  { kind: "other", label: "Other changes undone" },
];

/** What going back to `release` takes away, grouped so the consequential parts lead. */
export function downgradeImpact(release: ReleaseOption): {
  total: number;
  releases: number;
  securityFixes: Reverted[];
  exposedTo: ReleaseOption["exposedTo"];
  groups: { kind: ReleaseChangeKind; label: string; changes: Reverted[] }[];
} {
  const reverted = release.reverted ?? [];
  return {
    total: reverted.length,
    releases: new Set(reverted.map((change) => change.version)).size,
    securityFixes: reverted.filter(
      (change) => change.kind === "security" || change.kind === "critical",
    ),
    exposedTo: release.exposedTo ?? [],
    groups: groupOrder
      .map((group) => ({
        ...group,
        changes: reverted.filter((change) => change.kind === group.kind),
      }))
      .filter((group) => group.changes.length > 0),
  };
}

/** Older manifests only supplied a free-form notes string. Keep it readable as rows. */
export function legacyReleaseChanges(notes: string): ReleaseChange[] {
  return notes
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 100)
    .map((title) => ({ kind: "other", title }));
}
