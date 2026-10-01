// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** Lexicographic canonical JSON: sorted keys, no whitespace. See design/02 §4.3. */
export function canonicalJSON(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => encode(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    entries.sort(([left], [right]) => compareKeys(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`).join(",")}}`;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
