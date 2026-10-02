// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

interface ParsedVersion {
  core: [number, number, number];
  pre: string[];
}

/** Compares product versions such as 1.2.3 and 1.2.3-alpha.4. */
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    const diff = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const count = Math.min(a.pre.length, b.pre.length);
  for (let index = 0; index < count; index += 1) {
    const diff = compareIdentifier(a.pre[index] ?? "", b.pre[index] ?? "");
    if (diff !== 0) return diff;
  }
  return a.pre.length - b.pre.length;
}

function parseVersion(value: string): ParsedVersion | null {
  const version = value.startsWith("v") ? value.slice(1) : value;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return null;
  const core: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const pre = match[4] ? match[4].split(".") : [];
  if (pre.some((part) => part.length === 0)) return null;
  return { core, pre };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left);
  const rightNumber = /^\d+$/.test(right);
  if (leftNumber && rightNumber) return Number(left) - Number(right);
  if (leftNumber) return -1;
  if (rightNumber) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
