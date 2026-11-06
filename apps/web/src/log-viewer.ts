// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { ServiceLogEntry } from "./services-client.ts";

/** The newest entries read when a viewer opens or a filter changes. */
export const LOG_INITIAL_LINES = 200;
/** Rendered lines are capped so a busy unit cannot slow the page; the oldest are dropped. */
export const LOG_MAX_LINES = 2000;
/** Follow asks again this often, and immediately when a read came back truncated. */
export const LOG_FOLLOW_MS = 2000;

export interface AppendResult {
  entries: ServiceLogEntry[];
  /** How many entries were new (already-seen cursors are ignored). */
  added: number;
  /** How many of the oldest entries were dropped to stay within the cap. */
  dropped: number;
}

/** Adds newer entries after the buffer, skipping cursors it already holds, and caps its length. */
export function appendEntries(
  buffer: readonly ServiceLogEntry[],
  incoming: readonly ServiceLogEntry[],
  cap: number = LOG_MAX_LINES,
): AppendResult {
  if (incoming.length === 0) return { entries: buffer as ServiceLogEntry[], added: 0, dropped: 0 };
  const seen = new Set(buffer.map((entry) => entry.cursor));
  const fresh = incoming.filter((entry) => !seen.has(entry.cursor));
  const merged = fresh.length === 0 ? [...buffer] : [...buffer, ...fresh];
  const dropped = Math.max(0, merged.length - cap);
  return {
    entries: dropped > 0 ? merged.slice(dropped) : merged,
    added: fresh.length,
    dropped,
  };
}

export type PriorityTone = "danger" | "warn" | "default" | "muted";

/** 0-3 (emergency to error) is danger, 4 warning, 7 debug is quiet; the rest read as plain text. */
export function priorityTone(priority: number | null): PriorityTone {
  if (priority === null) return "default";
  if (priority <= 3) return "danger";
  if (priority === 4) return "warn";
  if (priority === 7) return "muted";
  return "default";
}

const TAGS = ["EMERG", "ALERT", "CRIT", "ERR", "WARN", "NOTICE", "INFO", "DEBUG"] as const;

export function priorityTag(priority: number | null): string {
  return priority === null ? "" : (TAGS[priority] ?? "");
}

/** Info lines carry no tag: most of a journal is info, and a tag on every line hides the rest. */
export function showsTag(priority: number | null): boolean {
  return priority !== null && priority !== 6;
}

export const priorityLevels = ["all", "3", "4", "5", "6"] as const;
export type PriorityLevel = (typeof priorityLevels)[number];

export function priorityParam(level: PriorityLevel): number | undefined {
  return level === "all" ? undefined : Number(level);
}

export const logRanges = ["any", "15m", "1h", "6h", "24h", "7d"] as const;
export type LogRange = (typeof logRanges)[number];

const RANGE_MS: Record<Exclude<LogRange, "any">, number> = {
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "6h": 6 * 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
};

export function rangeSince(range: LogRange, now: number): number | undefined {
  return range === "any" ? undefined : now - RANGE_MS[range];
}

const two = (value: number): string => String(value).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `14:03:09` for today, `Nov 5 14:03:09` before that, in the viewer's time zone. */
export function formatLogTime(ts: number, now: number): string {
  const date = new Date(ts);
  const today = new Date(now);
  const clock = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? clock : `${MONTHS[date.getMonth()]} ${date.getDate()} ${clock}`;
}

/** The full local timestamp, for copying and for a line's tooltip. */
export function formatFullTime(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** The program that wrote the line, when it adds something beyond the unit already on screen. */
export function sourceOf(entry: ServiceLogEntry, units: readonly string[]): string {
  if (!entry.identifier) return "";
  const known = units.some((unit) => unit.replace(/\.[a-z]+$/, "") === entry.identifier);
  if (known && units.length === 1) return "";
  return entry.pid === null ? entry.identifier : `${entry.identifier}[${entry.pid}]`;
}

export function entryText(entry: ServiceLogEntry, units: readonly string[]): string {
  const tag = showsTag(entry.priority) ? ` ${priorityTag(entry.priority)}` : "";
  const source = sourceOf(entry, units);
  return `${formatFullTime(entry.ts)}${tag}${source ? ` ${source}:` : ""} ${entry.message}`;
}

export function linesText(entries: readonly ServiceLogEntry[], units: readonly string[]): string {
  return entries.map((entry) => entryText(entry, units)).join("\n");
}

export function downloadName(units: readonly string[], now: number): string {
  const date = new Date(now);
  const stamp = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
  const subject = units.length === 1 ? (units[0] ?? "journal") : "journal";
  return `${subject}-${stamp}.log`;
}

export function isNearBottom(
  element: { scrollTop: number; scrollHeight: number; clientHeight: number },
  slack = 24,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= slack;
}
