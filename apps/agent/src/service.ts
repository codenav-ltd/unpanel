// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { existsSync } from "node:fs";
import {
  SERVICE_AGENT_UNIT,
  serviceGuard,
  serviceMethods,
  type ServiceActionName,
  type ServiceDetail,
  type ServiceOperation,
  type ServiceSummary,
  type ServiceTimer,
} from "@unpanel/protocol";
import {
  execSystemd,
  ServiceError,
  type ServiceExec,
  type ServiceExecResult,
} from "./service-exec.ts";
import { fitEntries, grepMatcher, parseJournal } from "./service-journal.ts";
export { ServiceError } from "./service-exec.ts";

const UINT64_MAX = "18446744073709551615";
/** Replies must beat the panel's own deadline (30 s for reads, 90 s for changes). */
const READ_TIMEOUT_MS = 25_000;
const CHANGE_TIMEOUT_MS = 80_000;
const GREP_FALLBACK_WINDOW = 5000;
const MAX_CONCURRENT = 8;
/** Output allowed per requested row when reading after a cursor (an entry is ~300 bytes, at most ~4.4 KB). */
const CONTINUATION_ROW_BYTES = 4096;

const showProperties = [
  "Id",
  "Description",
  "LoadState",
  "ActiveState",
  "SubState",
  "UnitFileState",
  "MainPID",
  "ActiveEnterTimestamp",
  "NRestarts",
  "MemoryCurrent",
  "CPUUsageNSec",
  "TasksCurrent",
  "FragmentPath",
  "DropInPaths",
  "Result",
].join(",");

const logFields = "MESSAGE,PRIORITY,_PID,SYSLOG_IDENTIFIER,_COMM";

/** `[not set]`, empty and `UINT64_MAX` all mean "systemd does not know". */
function present(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  return value === "" || value === "[not set]" || value === UINT64_MAX ? null : value;
}

function count(raw: string | undefined): number | null {
  const value = present(raw);
  if (value === null || !/^\d+$/.test(value)) return null;
  return Number(value);
}

/** `Fri 2026-11-06 10:15:03 UTC`; the agent runs systemd tools with `TZ=UTC`. */
function timestamp(raw: string | undefined): number | null {
  const match = /(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(present(raw) ?? "");
  if (!match) return null;
  const [year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0] = match
    .slice(1)
    .map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/** `systemctl show` output: `Key=Value` lines. */
export function parseShow(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1));
  }
  return values;
}

export function toDetail(unit: string, values: Map<string, string>): ServiceDetail {
  const pid = count(values.get("MainPID"));
  const fragment = present(values.get("FragmentPath"));
  return {
    name: present(values.get("Id")) ?? unit,
    description: values.get("Description")?.trim() ?? "",
    loadState: present(values.get("LoadState")) ?? "unknown",
    activeState: present(values.get("ActiveState")) ?? "unknown",
    subState: present(values.get("SubState")) ?? "unknown",
    unitFileState: present(values.get("UnitFileState")),
    mainPid: pid === 0 ? null : pid,
    activeSince: timestamp(values.get("ActiveEnterTimestamp")),
    restarts: count(values.get("NRestarts")),
    memoryBytes: count(values.get("MemoryCurrent")),
    cpuNanoseconds: count(values.get("CPUUsageNSec")),
    tasks: count(values.get("TasksCurrent")),
    fragmentPath: fragment,
    dropIns: (present(values.get("DropInPaths")) ?? "").split(/\s+/).filter(Boolean),
    result: present(values.get("Result")),
  };
}

/** `list-units --plain --no-legend`: `UNIT LOAD ACTIVE SUB DESCRIPTION…`, some versions with a leading bullet. */
export function parseUnits(stdout: string): Omit<ServiceSummary, "unitFileState">[] {
  const rows: Omit<ServiceSummary, "unitFileState">[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(?:[^\s\w]\s+)?(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*?)\s*$/.exec(
      line,
    );
    if (!match) continue;
    const [, name = "", loadState = "", activeState = "", subState = "", description = ""] = match;
    rows.push({ name, description, loadState, activeState, subState });
  }
  return rows;
}

/** `list-unit-files --plain --no-legend`: `UNIT_FILE STATE [PRESET]`. */
export function parseUnitFiles(stdout: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\S+\.service)\s+(\S+)/.exec(line);
    const [, name, state] = match ?? [];
    if (name && state) files.set(name, state);
  }
  return files;
}

/** The unit file state of an instance such as `getty@tty1.service` is that of its template. */
function fileState(files: Map<string, string>, name: string): string | null {
  return files.get(name) ?? files.get(name.replace(/@[^.@]+(\.[a-z]+)$/, "@$1")) ?? null;
}

export function mergeUnits(
  units: Omit<ServiceSummary, "unitFileState">[],
  files: Map<string, string>,
): ServiceSummary[] {
  const merged = new Map<string, ServiceSummary>();
  for (const unit of units) {
    merged.set(unit.name, { ...unit, unitFileState: fileState(files, unit.name) });
  }
  for (const [name, state] of files) {
    // Templates cannot run and aliases are another name for a unit listed on its own.
    if (merged.has(name) || name.endsWith("@.service") || state === "alias") continue;
    merged.set(name, {
      name,
      description: "",
      loadState: state.startsWith("masked") ? "masked" : "not-loaded",
      activeState: "inactive",
      subState: "dead",
      unitFileState: state,
    });
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
}

const timerStamp = /[A-Z][a-z]{2} \d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?: [A-Za-z][A-Za-z0-9+-]*)?/g;

/** `list-timers --plain --no-legend`: `NEXT LEFT LAST PASSED UNIT ACTIVATES`, where times may be `n/a`. */
export function parseTimers(stdout: string): ServiceTimer[] {
  const timers: ServiceTimer[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^(.*?)\s+(\S+\.timer)\s+(\S+)\s*$/.exec(line.trim());
    if (!match) continue;
    const [, head = "", unit = "", activates = ""] = match;
    const stamps = [...head.matchAll(timerStamp)];
    const next = stamps[0]?.index === 0 ? stamps[0] : undefined;
    const last = next ? stamps[1] : stamps[0];
    timers.push({
      unit,
      activates,
      next: next ? timestamp(next[0]) : null,
      last: last ? timestamp(last[0]) : null,
    });
  }
  return timers;
}

/** The part of `stderr` worth showing a person. */
function readable(result: ServiceExecResult): string {
  const text = (result.stderr.trim() || result.stdout.trim()).replace(/\s*\n\s*/g, " ");
  if (text === "") return `it exited with code ${result.code}`;
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

const missing =
  /Unit \S+ (?:not found|could not be found|not loaded)|No files found for|Unit file \S+ does not exist/i;

/** Throws the right error for a failed systemctl/journalctl call. */
function failure(label: string, result: ServiceExecResult): never {
  const text = `${result.stderr}\n${result.stdout}`;
  if (/System has not been booted with systemd|Failed to connect to (system )?bus/i.test(text)) {
    throw new ServiceError("E_CAPABILITY_MISSING", "systemd is not running on this machine.");
  }
  if (/access denied|interactive authentication required|permission denied/i.test(text)) {
    throw new ServiceError(
      "E_POLICY_DENIED",
      `systemd refused ${label}: the agent is not allowed to do this. Run the agent as root.`,
    );
  }
  if (/is masked/i.test(text)) {
    throw new ServiceError(
      "E_PRECONDITION",
      `${label} failed: the unit is masked. Unmask it on the node first.`,
    );
  }
  if (missing.test(text)) {
    throw new ServiceError(
      "E_NOT_FOUND",
      "This unit does not exist on the node. Refresh the list.",
    );
  }
  throw new ServiceError("E_EXTERNAL", `${label} failed: ${readable(result)}`);
}

function guardChange(
  unit: string,
  change: ServiceActionName | "enable" | "disable",
  confirm?: string,
) {
  const verdict = serviceGuard(unit, change);
  if (verdict === "refused") {
    throw new ServiceError(
      "E_POLICY_DENIED",
      `${SERVICE_AGENT_UNIT} cannot be changed from here: once it stops, nothing can bring this node back remotely. Use the agent upgrade on the node's page instead.`,
    );
  }
  if (verdict === "confirm" && confirm !== unit) {
    throw new ServiceError(
      "E_PRECONDITION",
      `${change === "disable" ? "Disabling" : "Stopping"} ${unit} can cut this node off. Type the unit name "${unit}" to confirm.`,
    );
  }
}

/** Whether this machine runs systemd (not a container, not macOS) and `systemctl` works. */
export function detectSystemd(
  options: {
    exists?: (path: string) => boolean;
    exec?: ServiceExec;
  } = {},
): Promise<{ version: number | null } | null> {
  if (!(options.exists ?? existsSync)("/run/systemd/system")) return Promise.resolve(null);
  return (options.exec ?? execSystemd)("systemctl", ["--version"], {
    timeoutMs: 5000,
    maxBytes: 65_536,
  })
    .then((result) => {
      if (result.code !== 0) return null;
      const version = /^systemd (\d+)/.exec(result.stdout);
      return { version: version ? Number(version[1]) : null };
    })
    .catch(() => null);
}

export function createService(options: { exec?: ServiceExec } = {}) {
  const exec = options.exec ?? execSystemd;
  let active = 0;

  async function launch(
    file: string,
    args: string[],
    timeoutMs: number,
    maxBytes: number,
    allowOverflow = false,
  ): Promise<ServiceExecResult> {
    if (active >= MAX_CONCURRENT) {
      throw new ServiceError("E_BUSY", "Too many service requests are running. Try again shortly.");
    }
    active += 1;
    try {
      return await exec(file, args, { timeoutMs, maxBytes, allowOverflow });
    } finally {
      active -= 1;
    }
  }

  /** One `systemctl` call that must succeed. `label` names it in error messages. */
  async function systemctl(
    args: string[],
    label: string,
    timeoutMs = READ_TIMEOUT_MS,
    maxBytes = 4_000_000,
  ): Promise<string> {
    const result = await launch(
      "systemctl",
      ["--no-ask-password", "--no-pager", ...args],
      timeoutMs,
      maxBytes,
    );
    if (result.code !== 0) failure(label, result);
    return result.stdout;
  }

  async function show(unit: string, properties: string): Promise<Map<string, string>> {
    return parseShow(await systemctl(["show", "-p", properties, unit], `Reading ${unit}`));
  }

  async function list() {
    const [units, files] = await Promise.all([
      systemctl(
        ["list-units", "--type=service", "--all", "--plain", "--no-legend", "--full"],
        "Listing services",
      ),
      systemctl(
        ["list-unit-files", "--type=service", "--plain", "--no-legend", "--full"],
        "Listing unit files",
      ),
    ]);
    return { units: mergeUnits(parseUnits(units), parseUnitFiles(files)) };
  }

  async function get(unit: string) {
    const values = await show(unit, showProperties);
    if (values.get("LoadState") === "not-found") {
      throw new ServiceError(
        "E_NOT_FOUND",
        "This unit does not exist on the node. Refresh the list.",
      );
    }
    return toDetail(unit, values);
  }

  async function cat(unit: string) {
    const text = await systemctl(["cat", unit], `Reading the unit file of ${unit}`);
    const bytes = Buffer.byteLength(text);
    // Stay well under the 1 MiB frame limit; a unit file is a few KiB.
    return {
      text:
        bytes > 600_000
          ? `${Buffer.from(text).subarray(0, 600_000).toString("utf8")}\n# … cut: the unit file is larger than 600 KB`
          : text,
    };
  }

  async function state(unit: string) {
    const values = await show(unit, "LoadState,ActiveState,SubState");
    return {
      status: "ok" as const,
      activeState: present(values.get("ActiveState")) ?? "unknown",
      subState: present(values.get("SubState")) ?? "unknown",
    };
  }

  async function action(unit: string, name: ServiceActionName, confirm?: string) {
    guardChange(unit, name, confirm);
    await systemctl([name, unit], `${name} ${unit}`, CHANGE_TIMEOUT_MS);
    return state(unit);
  }

  async function enable(unit: string, now: boolean) {
    guardChange(unit, "enable");
    await systemctl(
      ["enable", ...(now ? ["--now"] : []), unit],
      `enable ${unit}`,
      CHANGE_TIMEOUT_MS,
    );
    return { status: "ok" as const };
  }

  async function disable(unit: string, now: boolean, confirm?: string) {
    guardChange(unit, "disable", confirm);
    await systemctl(
      ["disable", ...(now ? ["--now"] : []), unit],
      `disable ${unit}`,
      CHANGE_TIMEOUT_MS,
    );
    return { status: "ok" as const };
  }

  async function daemonReload() {
    await systemctl(["daemon-reload"], "daemon-reload", CHANGE_TIMEOUT_MS);
    return { status: "ok" as const };
  }

  async function timers() {
    const out = await systemctl(
      ["list-timers", "--all", "--plain", "--no-legend", "--full"],
      "Listing timers",
    );
    return { timers: parseTimers(out) };
  }

  async function logs(params: Input<"logs">) {
    const follow = params.cursor !== undefined;
    let useFields = true;
    let useGrep = params.grep !== undefined;
    let result: ServiceExecResult | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // The rows the answer may need: one more than asked, to learn whether there are more.
      const rows = params.grep !== undefined && !useGrep ? GREP_FALLBACK_WINDOW : params.lines + 1;
      const args = [
        "-o",
        "json",
        "--no-pager",
        ...(useFields ? [`--output-fields=${logFields}`] : []),
        ...params.units.flatMap((unit) => ["-u", unit]),
        // A tail is the newest rows, listed newest first. After a cursor `-n` would also mean the
        // newest rows, which would skip the ones right after the cursor; so a continuation has no `-n`
        // and is cut by the output limit instead, which keeps the oldest rows.
        ...(params.cursor === undefined
          ? ["--reverse", "-n", String(rows)]
          : [`--after-cursor=${params.cursor}`]),
        ...(params.since === undefined ? [] : [`--since=@${Math.floor(params.since / 1000)}`]),
        ...(params.until === undefined ? [] : [`--until=@${Math.ceil(params.until / 1000)}`]),
        ...(params.priority === undefined ? [] : ["-p", String(params.priority)]),
        ...(params.grep !== undefined && useGrep ? [`--grep=${params.grep}`] : []),
      ];
      result = await launch(
        "journalctl",
        args,
        READ_TIMEOUT_MS,
        follow ? rows * CONTINUATION_ROW_BYTES + 65_536 : 32_000_000,
        follow,
      );
      if (result.code === 0) break;
      const text = result.stderr;
      if (useFields && /output-fields/.test(text) && /unrecognized|invalid/i.test(text)) {
        useFields = false;
      } else if (
        useGrep &&
        /Compiled without pattern|unrecognized option '--grep|invalid option -- 'g'/i.test(text)
      ) {
        useGrep = false;
      } else if (/Bad pattern|Failed to compile/i.test(text)) {
        throw new ServiceError(
          "E_INVALID_PARAMS",
          "The search pattern is not a valid regular expression.",
        );
      } else if (follow && /cursor/i.test(text)) {
        throw new ServiceError(
          "E_INVALID_PARAMS",
          "The log position is no longer valid. Reload the logs.",
        );
      } else {
        failure("Reading the logs", result);
      }
    }
    if (!result || result.code !== 0)
      failure("Reading the logs", result ?? { code: 1, stdout: "", stderr: "" });

    // `--reverse` lists the newest first; a continuation after a cursor already runs oldest first.
    // A cut continuation ends in a partial line, which is dropped.
    const overflow = result.overflow === true;
    const text = overflow
      ? result.stdout.slice(0, result.stdout.lastIndexOf("\n") + 1)
      : result.stdout;
    let entries = parseJournal(text).entries;
    if (!follow) entries = entries.toReversed();
    else entries = entries.filter((entry) => entry.cursor !== params.cursor);
    let windowFull = false;
    if (params.grep !== undefined && !useGrep) {
      windowFull = overflow || entries.length >= GREP_FALLBACK_WINDOW;
      const matches = grepMatcher(params.grep);
      entries = entries.filter((entry) => matches(entry.message));
    }
    const over = entries.length > params.lines;
    const wanted = follow ? entries.slice(0, params.lines) : entries.slice(-params.lines);
    const fit = fitEntries(wanted, follow ? "oldest" : "newest");
    return { entries: fit.entries, truncated: over || overflow || fit.cut || windowFull };
  }

  async function run(operation: ServiceOperation, params: unknown): Promise<unknown> {
    switch (operation) {
      case "list":
        input("list", params);
        return list();
      case "get":
        return get(input("get", params).unit);
      case "cat":
        return cat(input("cat", params).unit);
      case "action": {
        const p = input("action", params);
        return action(p.unit, p.action, p.confirm);
      }
      case "enable": {
        const p = input("enable", params);
        return enable(p.unit, p.now);
      }
      case "disable": {
        const p = input("disable", params);
        return disable(p.unit, p.now, p.confirm);
      }
      case "daemonReload":
        input("daemonReload", params);
        return daemonReload();
      case "timers":
        input("timers", params);
        return timers();
      case "logs":
        return logs(input("logs", params));
    }
  }

  return { run };
}

type Input<O extends ServiceOperation> = ReturnType<(typeof serviceMethods)[O]["params"]["parse"]>;

/** Validates request parameters with the protocol schema. */
function input<O extends ServiceOperation>(operation: O, params: unknown): Input<O> {
  const parsed = serviceMethods[operation].params.safeParse(params);
  if (!parsed.success) {
    throw new ServiceError(
      "E_INVALID_PARAMS",
      parsed.error.issues[0]?.message ?? "The request is not valid.",
    );
  }
  return parsed.data as Input<O>;
}
