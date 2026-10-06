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
  reviewRequired: boolean;
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
