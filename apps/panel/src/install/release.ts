// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { compareVersions } from "@unpanel/shared";

/** `v1.2.3` or `v1.2.3-alpha.0`. Other names are ignored. */
export function parseReleaseTag(name: string): string | null {
  const version = name.startsWith("v") ? name.slice(1) : name;
  return compareVersions(version, version) === 0 ? `v${version}` : null;
}

/** The greatest release tag strictly newer than `current`, or null. */
export function newerRelease(current: string, names: string[]): string | null {
  const currentVersion = parseReleaseTag(current);
  if (!currentVersion) return null;
  let best: string | null = null;
  for (const name of names) {
    const tag = parseReleaseTag(name);
    if (!tag) continue;
    if (compareTags(tag, currentVersion) <= 0) continue;
    if (!best || compareTags(tag, best) > 0) best = tag;
  }
  return best;
}

/** Keeps release tag names and drops peeled `^{}` lines. */
export function tagNames(lsRemote: string): string[] {
  const names: string[] = [];
  for (const line of lsRemote.split("\n")) {
    const tab = line.split("\t");
    const ref = tab[1]?.trim();
    if (!ref || ref.endsWith("^{}")) continue;
    const name = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : ref;
    if (parseReleaseTag(name)) names.push(name);
  }
  return names;
}

function compareTags(left: string, right: string): number {
  return compareVersions(left, right) ?? 0;
}
