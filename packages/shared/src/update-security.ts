// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { compareVersions } from "./version.ts";

export type AdvisorySeverity = "low" | "moderate" | "high" | "critical";
export interface SecurityAdvisory {
  id: string;
  title: string;
  severity: AdvisorySeverity;
  affected: { from: string; below: string }[];
  fixedVersion: string;
  publishedAt: string;
  deadline?: string;
  url?: string;
  mitigation?: string;
}
export interface SecurityUpdatePolicy {
  criticalAction: "notify" | "install_after_deadline";
  graceHours: 6 | 24 | 72;
  notifyChannels: boolean;
}
export interface SecurityUpdateStatus {
  advisories: SecurityAdvisory[];
  policy: SecurityUpdatePolicy;
  checkedAt: number | null;
  installAt: number | null;
  hold: string | null;
}
export const defaultSecurityUpdatePolicy = (): SecurityUpdatePolicy => ({
  criticalAction: "notify",
  graceHours: 24,
  notifyChannels: true,
});
export const severityRank: Record<AdvisorySeverity, number> = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
};
/** Keep merged sources and persisted warning snapshots within the registry limit. */
export function mergeSecurityAdvisories(...lists: SecurityAdvisory[][]): SecurityAdvisory[] {
  return [...new Map(lists.flat().map((item) => [item.id, item])).values()]
    .sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || a.id.localeCompare(b.id))
    .slice(0, 64);
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Security advisory text is invalid.");
  return value.trim();
}
function version(value: unknown): string {
  const result = text(value, 80);
  if (
    !/^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(
      result,
    ) ||
    compareVersions(result, result) !== 0
  )
    throw new Error("Security advisory version is invalid.");
  return result;
}
function date(value: unknown): string {
  const result = text(value, 24);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(result) ||
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString() !== result.replace("Z", ".000Z")
  )
    throw new Error("Security advisory date must be a valid UTC timestamp.");
  return result;
}
export function parseSecurityAdvisories(value: unknown): SecurityAdvisory[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("Security advisories must be a bounded list.");
  const ids = new Set<string>();
  return value.map((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Security advisory is invalid.");
    const row = input as Record<string, unknown>,
      id = text(row["id"], 80),
      title = text(row["title"], 200),
      severity = row["severity"];
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || ids.has(id))
      throw new Error("Security advisory IDs must be unique.");
    ids.add(id);
    if (
      severity !== "low" &&
      severity !== "moderate" &&
      severity !== "high" &&
      severity !== "critical"
    )
      throw new Error("Security advisory severity is invalid.");
    const fixedVersion = version(row["fixedVersion"]),
      publishedAt = date(row["publishedAt"]);
    if (!Array.isArray(row["affected"]) || !row["affected"].length || row["affected"].length > 8)
      throw new Error("Security advisory needs affected version ranges.");
    const affected = row["affected"].map((range) => {
      if (!range || typeof range !== "object")
        throw new Error("Security advisory range is invalid.");
      const from = version(range.from),
        below = version(range.below);
      if (
        (compareVersions(from, below) ?? 0) >= 0 ||
        (compareVersions(below, fixedVersion) ?? 1) > 0
      )
        throw new Error("Security advisory range must end at or before the fixed version.");
      return { from, below };
    });
    const result: SecurityAdvisory = { id, title, severity, fixedVersion, publishedAt, affected };
    if (row["deadline"] !== undefined) {
      result.deadline = date(row["deadline"]);
      if (Date.parse(result.deadline) < Date.parse(publishedAt))
        throw new Error("Security deadline precedes publication.");
    }
    if (row["url"] !== undefined) {
      const url = new URL(text(row["url"], 2048));
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Security advisory link must use HTTPS.");
      result.url = url.href;
    }
    if (row["mitigation"] !== undefined) result.mitigation = text(row["mitigation"], 2000);
    return result;
  });
}
export function affectedBy(current: string, advisory: SecurityAdvisory, now = Date.now()): boolean {
  if (Date.parse(advisory.publishedAt) > now) return false;
  return advisory.affected.some((range) => {
    const from = compareVersions(current, range.from),
      below = compareVersions(current, range.below);
    return from !== null && below !== null && from >= 0 && below < 0;
  });
}
