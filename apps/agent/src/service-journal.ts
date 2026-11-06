// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { ServiceLogEntry } from "@unpanel/protocol";

/**
 * A reply frame may not exceed 1 MiB (`MAX_TEXT_FRAME_BYTES`). Entries are cut to this many bytes of
 * JSON, which leaves room for the frame envelope and the other result fields.
 */
export const LOG_RESULT_BYTES = 700_000;
export const LOG_MESSAGE_CHARS = 16_384;
const OMITTED = "[message omitted: journald does not show fields larger than 4 KiB]";

/** `null` when journald replaced a too-large field with `null`, `undefined` when the field is absent. */
export function fieldText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    // Non-UTF-8 payloads arrive as arrays of byte values; a repeated field as an array of strings.
    if (value.length > 0 && value.every((item) => Number.isInteger(item) && item >= 0)) {
      return Buffer.from(value as number[]).toString("utf8");
    }
    const first = value.find((item): item is string => typeof item === "string");
    return first ?? null;
  }
  return null;
}

function integer(value: unknown): number | null {
  const text = fieldText(value);
  if (typeof text !== "string" || !/^\d{1,16}$/.test(text.trim())) return null;
  return Number(text.trim());
}

function clip(message: string): string {
  const clean = message.replace(/[\r\n]+$/, "");
  return clean.length > LOG_MESSAGE_CHARS
    ? `${clean.slice(0, LOG_MESSAGE_CHARS)} …[truncated]`
    : clean;
}

function entryFrom(record: Record<string, unknown>): ServiceLogEntry | null {
  const cursor = fieldText(record["__CURSOR"]);
  const micros = integer(record["__REALTIME_TIMESTAMP"]);
  if (typeof cursor !== "string" || cursor === "" || micros === null) return null;
  const priority = integer(record["PRIORITY"]);
  const message = fieldText(record["MESSAGE"]);
  const identifier = fieldText(record["SYSLOG_IDENTIFIER"]) ?? fieldText(record["_COMM"]);
  return {
    cursor,
    ts: Math.floor(micros / 1000),
    priority: priority !== null && priority <= 7 ? priority : null,
    pid: integer(record["_PID"]),
    identifier: identifier ? identifier : null,
    message: message === null ? OMITTED : clip(message ?? ""),
  };
}

/** Reads `journalctl -o json` output (one object per line), skipping lines it cannot make sense of. */
export function parseJournal(stdout: string): { entries: ServiceLogEntry[]; skipped: number } {
  const entries: ServiceLogEntry[] = [];
  let skipped = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const entry =
      typeof record === "object" && record !== null && !Array.isArray(record)
        ? entryFrom(record as Record<string, unknown>)
        : null;
    if (entry) entries.push(entry);
    else skipped += 1;
  }
  return { entries, skipped };
}

/**
 * Keeps entries while their JSON fits `budget` bytes: the newest ones when `keep` is `newest`
 * (a tail), the oldest ones when it is `oldest` (a continuation after a cursor).
 * Always keeps at least one entry, since a single message is clipped well below the budget.
 */
export function fitEntries(
  entries: readonly ServiceLogEntry[],
  keep: "newest" | "oldest",
  budget = LOG_RESULT_BYTES,
): { entries: ServiceLogEntry[]; cut: boolean } {
  const ordered = keep === "newest" ? entries.toReversed() : [...entries];
  let used = 0;
  const kept: ServiceLogEntry[] = [];
  for (const entry of ordered) {
    used += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (used > budget && kept.length > 0) break;
    kept.push(entry);
  }
  return {
    entries: keep === "newest" ? kept.toReversed() : kept,
    cut: kept.length < entries.length,
  };
}

/**
 * The fallback for journald builds without PCRE2: the pattern is matched as literal text, case-insensitive
 * unless it has capitals (journalctl's own smart-case rule). It is not run as a regular expression, so a
 * pathological pattern cannot stall the agent.
 */
export function grepMatcher(pattern: string): (message: string) => boolean {
  if (/[A-Z]/.test(pattern)) return (message) => message.includes(pattern);
  const needle = pattern.toLowerCase();
  return (message) => message.toLowerCase().includes(needle);
}
