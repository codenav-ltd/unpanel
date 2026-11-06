// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { z } from "zod";
import { defineMethod } from "../methods.ts";

/** systemd service methods. See modules/services.md. */

export const SERVICE_LOG_LIMIT = 1000;
export const SERVICE_LOG_UNITS = 4;

export const serviceOperations = [
  "list",
  "get",
  "cat",
  "action",
  "enable",
  "disable",
  "daemonReload",
  "timers",
  "logs",
] as const;
export type ServiceOperation = (typeof serviceOperations)[number];

/**
 * A unit name as `systemctl` takes it. Anything else is rejected before a process starts,
 * and a name can never begin with `-`, so it cannot be read as an option.
 */
export const serviceUnitName = z
  .string()
  .max(256)
  .regex(
    /^[a-zA-Z0-9:_.@][a-zA-Z0-9:_.@-]*\.(service|socket|timer|target|path|mount)$/,
    "Not a valid systemd unit name.",
  );

export const serviceActionName = z.enum(["start", "stop", "restart", "reload", "try-restart"]);
export type ServiceActionName = z.infer<typeof serviceActionName>;

/** What the caller must do before a change to one unit goes ahead. */
export type ServiceGuard = "free" | "confirm" | "refused";

const protectedUnits = [
  /^sshd?\.service$/,
  /^systemd-[^/]*$/,
  /^dbus[^/]*\.service$/,
  /^networking\.service$/,
  /^NetworkManager\.service$/,
  /^docker\.service$/,
  /^containerd\.service$/,
  /^unpanel\.service$/,
];

export const SERVICE_AGENT_UNIT = "unpanel-agent.service";

/**
 * Stopping, disabling or restarting some units can cut the node off. The agent unit is
 * refused outright, because nothing could bring the node back remotely; the others need the
 * caller to type the unit name as `confirm`. Starting, reloading and enabling are always free.
 */
export function serviceGuard(
  unit: string,
  change: ServiceActionName | "enable" | "disable",
): ServiceGuard {
  if (unit === SERVICE_AGENT_UNIT) return "refused";
  if (change !== "stop" && change !== "disable") return "free";
  return protectedUnits.some((pattern) => pattern.test(unit)) ? "confirm" : "free";
}

const confirm = z.string().max(256).optional();

export const serviceSummary = z.object({
  name: z.string(),
  description: z.string(),
  loadState: z.string(),
  activeState: z.string(),
  subState: z.string(),
  /** `enabled`, `disabled`, `static`, `masked` and so on; `null` when no unit file is installed. */
  unitFileState: z.string().nullable(),
});
export type ServiceSummary = z.infer<typeof serviceSummary>;

/** Memory, CPU and task counts are `null` when systemd does not account for them. */
export const serviceDetail = serviceSummary.extend({
  mainPid: z.number().int().nonnegative().nullable(),
  /** Milliseconds since the epoch, when the unit last became active. */
  activeSince: z.number().nullable(),
  restarts: z.number().int().nonnegative().nullable(),
  memoryBytes: z.number().nonnegative().nullable(),
  cpuNanoseconds: z.number().nonnegative().nullable(),
  tasks: z.number().int().nonnegative().nullable(),
  fragmentPath: z.string().nullable(),
  dropIns: z.array(z.string()),
  /** The last exit result, such as `success` or `exit-code`. */
  result: z.string().nullable(),
});
export type ServiceDetail = z.infer<typeof serviceDetail>;

export const serviceTimer = z.object({
  unit: z.string(),
  activates: z.string(),
  /** Milliseconds since the epoch; `null` when the timer has no next or last run. */
  next: z.number().nullable(),
  last: z.number().nullable(),
});
export type ServiceTimer = z.infer<typeof serviceTimer>;

export const serviceLogEntry = z.object({
  /** journald's cursor for this entry; pass the last one as `cursor` to read what came after. */
  cursor: z.string(),
  /** Milliseconds since the epoch. */
  ts: z.number(),
  /** Syslog priority, 0 (emerg) to 7 (debug). */
  priority: z.number().int().min(0).max(7).nullable(),
  pid: z.number().int().nullable(),
  identifier: z.string().nullable(),
  message: z.string(),
});
export type ServiceLogEntry = z.infer<typeof serviceLogEntry>;

const unitParams = z.object({ unit: serviceUnitName }).strict();
const ok = z.object({ status: z.literal("ok") });
const changed = z.object({
  status: z.literal("ok"),
  activeState: z.string(),
  subState: z.string(),
});

const parameterSchemas = {
  list: z.object({}).strict(),
  get: unitParams,
  cat: unitParams,
  action: z.object({ unit: serviceUnitName, action: serviceActionName, confirm }).strict(),
  enable: z.object({ unit: serviceUnitName, now: z.boolean().default(false) }).strict(),
  disable: z.object({ unit: serviceUnitName, now: z.boolean().default(false), confirm }).strict(),
  daemonReload: z.object({}).strict(),
  timers: z.object({}).strict(),
  logs: z
    .object({
      units: z.array(serviceUnitName).min(1).max(SERVICE_LOG_UNITS),
      lines: z.number().int().min(1).max(SERVICE_LOG_LIMIT).default(200),
      /** Return only entries after this journald cursor; `lines` then counts from the oldest of them. */
      cursor: z.string().max(512).optional(),
      /** Milliseconds since the epoch. */
      since: z.number().nonnegative().optional(),
      until: z.number().nonnegative().optional(),
      /** Show this priority and more severe ones (0–7). */
      priority: z.number().int().min(0).max(7).optional(),
      grep: z.string().min(1).max(200).optional(),
    })
    .strict(),
} as const;

const results = {
  list: z.object({ units: z.array(serviceSummary) }),
  get: serviceDetail,
  cat: z.object({ text: z.string().max(1_000_000) }),
  action: changed,
  enable: ok,
  disable: ok,
  daemonReload: ok,
  timers: z.object({ timers: z.array(serviceTimer) }),
  logs: z.object({
    entries: z.array(serviceLogEntry),
    /** More entries matched than `lines` allowed. */
    truncated: z.boolean(),
  }),
} as const;

const writes: readonly ServiceOperation[] = ["action", "enable", "disable", "daemonReload"];

function method<Operation extends ServiceOperation>(operation: Operation) {
  const write = writes.includes(operation);
  return defineMethod<
    z.infer<(typeof parameterSchemas)[Operation]>,
    z.infer<(typeof results)[Operation]>
  >({
    name: `service.${operation}`,
    capability: "systemd",
    risk: write ? "write" : "read",
    permission: write ? "service:write" : "service:read",
    timeoutMs: operation === "action" || operation === "daemonReload" ? 90_000 : 30_000,
    params: parameterSchemas[operation] as never,
    result: results[operation] as never,
    since: "0.1.0",
  });
}

export const serviceMethods = {
  list: method("list"),
  get: method("get"),
  cat: method("cat"),
  action: method("action"),
  enable: method("enable"),
  disable: method("disable"),
  daemonReload: method("daemonReload"),
  timers: method("timers"),
  logs: method("logs"),
};
