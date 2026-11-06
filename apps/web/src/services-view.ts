// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { serviceGuard, serviceUnitName, type ServiceGuard } from "./service-protocol.ts";
import type { ServiceChange, ServiceSummary, ServiceTimer } from "./services-client.ts";

/** How the list is narrowed. `all` shows every unit systemd knows about. */
export type ServiceFilter = "all" | "running" | "failed" | "enabled";
export const serviceFilters: readonly ServiceFilter[] = ["all", "running", "failed", "enabled"];

export type StateTone = "ok" | "idle" | "warn" | "danger" | "off";

export const isFailed = (unit: ServiceSummary): boolean => unit.activeState === "failed";
export const isRunning = (unit: ServiceSummary): boolean =>
  unit.activeState === "active" && unit.subState === "running";
export const isEnabled = (unit: ServiceSummary): boolean =>
  unit.unitFileState === "enabled" || unit.unitFileState === "enabled-runtime";
/** Masked units refuse to start, and units with no file on disk have nothing to change. */
export const isMasked = (unit: ServiceSummary): boolean =>
  unit.loadState === "masked" || unit.unitFileState === "masked";
/**
 * Names with backslash escapes (`systemd-fsck@dev-disk-by\x2d...`) appear in the list but the
 * protocol refuses them in every other call, so nothing can be asked of them.
 */
export const isAddressable = (name: string): boolean => serviceUnitName.safeParse(name).success;
export const isMissing = (unit: ServiceSummary): boolean => unit.loadState === "not-found";

/** Only these file states can be flipped; `static`, `generated` and the rest cannot. */
export type StartupState = "enabled" | "disabled" | "fixed";
export function startupState(unit: ServiceSummary): StartupState {
  if (isEnabled(unit)) return "enabled";
  if (unit.unitFileState === "disabled") return "disabled";
  return "fixed";
}

export function stateTone(unit: ServiceSummary): StateTone {
  if (isFailed(unit)) return "danger";
  if (isMasked(unit) || isMissing(unit)) return "off";
  if (unit.activeState === "active") return unit.subState === "running" ? "ok" : "idle";
  if (["activating", "deactivating", "reloading", "refreshing"].includes(unit.activeState))
    return "warn";
  return "off";
}

/** The word shown next to the dot: the sub-state while active, the state otherwise. */
export function stateText(unit: ServiceSummary): string {
  if (isMasked(unit)) return "masked";
  if (isMissing(unit)) return "not found";
  if (unit.activeState === "active") return unit.subState || "active";
  if (unit.activeState === "failed") return "failed";
  if (unit.subState && unit.subState !== "dead" && unit.subState !== unit.activeState)
    return `${unit.activeState} (${unit.subState})`;
  return unit.activeState || "unknown";
}

export function matchesFilter(unit: ServiceSummary, filter: ServiceFilter): boolean {
  if (filter === "running") return isRunning(unit);
  if (filter === "failed") return isFailed(unit);
  if (filter === "enabled") return isEnabled(unit);
  return true;
}

export function matchesQuery(unit: ServiceSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${unit.name} ${unit.description}`.toLowerCase().includes(needle);
}

export interface ServiceCounts {
  all: number;
  running: number;
  failed: number;
  enabled: number;
}

export function countUnits(units: readonly ServiceSummary[]): ServiceCounts {
  const counts: ServiceCounts = { all: units.length, running: 0, failed: 0, enabled: 0 };
  for (const unit of units) {
    if (isRunning(unit)) counts.running++;
    if (isFailed(unit)) counts.failed++;
    if (isEnabled(unit)) counts.enabled++;
  }
  return counts;
}

/** Failed units first because they are why most people open the page, then active ones. */
function rank(unit: ServiceSummary): number {
  if (isFailed(unit)) return 0;
  if (unit.activeState === "active" || stateTone(unit) === "warn") return 1;
  return 2;
}

export function sortUnits(units: readonly ServiceSummary[]): ServiceSummary[] {
  return [...units].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );
}

export function visibleUnits(
  units: readonly ServiceSummary[],
  filter: ServiceFilter,
  query: string,
): ServiceSummary[] {
  return sortUnits(
    units.filter((unit) => matchesFilter(unit, filter) && matchesQuery(unit, query)),
  );
}

/** What a row or the drawer offers. `id` is stable for menus and tests; labels live in i18n. */
export interface ServiceChoice {
  id: "start" | "restart" | "stop" | "reload" | "enable" | "enable-now" | "disable" | "disable-now";
  change: ServiceChange;
}

const choice = (id: ServiceChoice["id"], change: ServiceChange): ServiceChoice => ({ id, change });

/** The quick button on a row: bring a stopped unit up, or restart a running one. */
export function primaryChoice(unit: ServiceSummary): ServiceChoice | null {
  if (isMasked(unit) || isMissing(unit) || !isAddressable(unit.name)) return null;
  return unit.activeState === "active" || stateTone(unit) === "warn"
    ? choice("restart", { kind: "action", action: "restart" })
    : choice("start", { kind: "action", action: "start" });
}

/** Everything else, in menu order. Empty when nothing can be changed. */
export function secondaryChoices(unit: ServiceSummary): ServiceChoice[] {
  if (isMasked(unit) || isMissing(unit) || !isAddressable(unit.name)) return [];
  const choices: ServiceChoice[] = [];
  const live = unit.activeState !== "inactive" && unit.activeState !== "failed";
  if (live) {
    choices.push(choice("stop", { kind: "action", action: "stop" }));
    if (unit.activeState === "active")
      choices.push(choice("reload", { kind: "action", action: "reload" }));
  } else {
    choices.push(choice("restart", { kind: "action", action: "restart" }));
  }
  const startup = startupState(unit);
  if (startup === "disabled") {
    choices.push(choice("enable", { kind: "enable", now: false }));
    choices.push(choice("enable-now", { kind: "enable", now: true }));
  } else if (startup === "enabled") {
    choices.push(choice("disable", { kind: "disable", now: false }));
    choices.push(choice("disable-now", { kind: "disable", now: true }));
  }
  return choices;
}

/** Which of the protocol's guards applies to a change. */
export function guardOf(unit: string, change: ServiceChange): ServiceGuard {
  return serviceGuard(unit, change.kind === "action" ? change.action : change.kind);
}

export function sortTimers(timers: readonly ServiceTimer[], query: string): ServiceTimer[] {
  const needle = query.trim().toLowerCase();
  return timers
    .filter((timer) => !needle || `${timer.unit} ${timer.activates}`.toLowerCase().includes(needle))
    .sort((a, b) => {
      if (a.next === null && b.next === null) return a.unit.localeCompare(b.unit);
      if (a.next === null) return 1;
      if (b.next === null) return -1;
      return a.next - b.next;
    });
}

const RELATIVE_STEPS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
];

/** "in 3 hours", "5 minutes ago". Sub-second differences read as "now". */
export function formatRelative(ts: number, now: number): string {
  const diff = ts - now;
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(diff) >= size || unit === "second")
      return formatter.format(Math.round(diff / size), unit);
  }
  return formatter.format(0, "second");
}

/** Accumulated CPU time as systemd reports it, in nanoseconds. */
export function formatCpuTime(nanoseconds: number): string {
  const seconds = nanoseconds / 1e9;
  if (seconds < 1) return `${Math.round(nanoseconds / 1e6)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(Math.floor(seconds % 60)).padStart(2, "0")} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

export type UnitFileLine =
  | { kind: "path"; text: string }
  | { kind: "comment"; text: string }
  | { kind: "section"; text: string }
  | { kind: "key"; key: string; value: string }
  | { kind: "plain"; text: string };

/**
 * `systemctl cat` prints each file after a `# /path` header. Splitting lines into kinds lets the
 * viewer dim comments and set section names apart without any HTML from the node.
 */
export function unitFileLines(text: string): UnitFileLine[] {
  return text.split("\n").map((line): UnitFileLine => {
    if (/^#\s*\/\S/.test(line)) return { kind: "path", text: line };
    if (/^\s*[#;]/.test(line)) return { kind: "comment", text: line };
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) return { kind: "section", text: line };
    const pair = /^(\s*[A-Za-z][A-Za-z0-9_-]*\s*=)(.*)$/.exec(line);
    if (pair) return { kind: "key", key: pair[1] ?? "", value: pair[2] ?? "" };
    return { kind: "plain", text: line };
  });
}

export const sentence = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
