// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

interface Parsed {
  core: [number, number, number];
  pre: string[];
}

/** `v1.2.3` or `v1.2.3-alpha.0`. Other names are ignored. */
export function parseReleaseTag(name: string): string | null {
  const version = name.startsWith("v") ? name.slice(1) : name;
  return parseVersion(version) ? `v${version}` : null;
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

/** Keeps tag names from `git ls-remote --tags` and drops peeled `^{}` lines. */
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
  const a = parseVersion(left.slice(1));
  const b = parseVersion(right.slice(1));
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    const diff = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const count = Math.min(a.pre.length, b.pre.length);
  for (let index = 0; index < count; index += 1) {
    const diff = compareId(a.pre[index] ?? "", b.pre[index] ?? "");
    if (diff !== 0) return diff;
  }
  return a.pre.length - b.pre.length;
}

function parseVersion(version: string): Parsed | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return null;
  const core: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const pre = match[4] ? match[4].split(".") : [];
  if (pre.some((part) => part.length === 0)) return null;
  return { core, pre };
}

function compareId(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left);
  const rightNumber = /^\d+$/.test(right);
  if (leftNumber && rightNumber) return Number(left) - Number(right);
  if (leftNumber) return -1;
  if (rightNumber) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
