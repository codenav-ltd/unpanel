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

/** Older manifests only supplied a free-form notes string. Keep it readable as rows. */
export function legacyReleaseChanges(notes: string): ReleaseChange[] {
  return notes
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 100)
    .map((title) => ({ kind: "other", title }));
}
