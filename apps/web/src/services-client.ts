// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type {
  ServiceActionName,
  ServiceDetail,
  ServiceLogEntry,
  ServiceOperation,
  ServiceSummary,
  ServiceTimer,
} from "./service-protocol.ts";
import { readProblem, replyNotReceived } from "./http-error.ts";

export type {
  ServiceActionName,
  ServiceDetail,
  ServiceLogEntry,
  ServiceSummary,
  ServiceTimer,
} from "./service-protocol.ts";

/** What `service.logs` accepts, minus the unit list the caller fixes per viewer. */
export interface ServiceLogQuery {
  units: string[];
  lines?: number;
  /** Return only entries after this journald cursor. */
  cursor?: string;
  since?: number;
  until?: number;
  /** Show this syslog priority and more severe ones (0-7). */
  priority?: number;
  grep?: string;
}

export interface ServiceLogPage {
  entries: ServiceLogEntry[];
  /** More entries matched than `lines` allowed. */
  truncated: boolean;
}

/** A change to one unit, as the page and the drawer describe it before it is sent. */
export type ServiceChange =
  | { kind: "action"; action: ServiceActionName }
  | { kind: "enable"; now: boolean }
  | { kind: "disable"; now: boolean };

export type ServiceChangeResult = { activeState: string; subState: string } | null;

export class ServicesRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** How the page should present a failure: a whole-page state, or a message beside the action. */
export type ServiceProblem =
  | "unavailable"
  | "forbidden"
  | "offline"
  | "not-found"
  | "precondition"
  | "denied"
  | "invalid"
  | "network"
  | "other";

export function serviceProblem(error: unknown): ServiceProblem {
  if (!(error instanceof ServicesRequestError)) return "other";
  switch (error.code) {
    // A node without systemd, or whose agent predates Services (the panel's own sentence says which).
    case "E_CAPABILITY_MISSING":
    case "E_UNSUPPORTED":
      return "unavailable";
    case "E_FORBIDDEN":
      return "forbidden";
    case "E_NODE_OFFLINE":
      return "offline";
    case "E_NOT_FOUND":
      return "not-found";
    case "E_PRECONDITION":
      return "precondition";
    // The node's own policy, or the agent's unit, refuses the change; the message says which.
    case "E_POLICY_DENIED":
      return "denied";
    // A cursor journald no longer knows, or parameters the panel rejected.
    case "E_INVALID_PARAMS":
      return "invalid";
    case "E_NETWORK":
      return "network";
    default:
      return "other";
  }
}

const WRITE_TIMEOUT_MS = 100_000;
const READ_TIMEOUT_MS = 40_000;

export interface CallOptions {
  signal?: AbortSignal;
}

/** Requests to `/api/v1/nodes/:id/service/*` for one node. */
export function servicesClient(node: string) {
  const base = `/api/v1/nodes/${encodeURIComponent(node)}/service`;

  async function call<T>(
    operation: ServiceOperation,
    body: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<T> {
    const write = ["action", "enable", "disable", "daemonReload"].includes(operation);
    const timeout = AbortSignal.timeout(write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${base}/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
    } catch (failure) {
      if (options.signal?.aborted) throw failure;
      throw new ServicesRequestError(
        write
          ? replyNotReceived("change this service", "Refresh the list before retrying.")
          : "Could not reach the panel. Check your connection and retry.",
        "E_NETWORK",
      );
    }
    if (!response.ok) {
      const code = await response
        .clone()
        .json()
        .then((reply: { error?: { code?: string } }) => reply.error?.code ?? "E_EXTERNAL")
        .catch(() => "E_EXTERNAL");
      throw new ServicesRequestError(
        await readProblem(response, write ? "change this service" : "read services"),
        code,
      );
    }
    return ((await response.json()) as { data: T }).data;
  }

  const action = (unit: string, name: ServiceActionName, confirm?: string) =>
    call<{ status: "ok"; activeState: string; subState: string }>("action", {
      unit,
      action: name,
      ...(confirm ? { confirm } : {}),
    });
  const enable = (unit: string, now: boolean) => call<{ status: "ok" }>("enable", { unit, now });
  const disable = (unit: string, now: boolean, confirm?: string) =>
    call<{ status: "ok" }>("disable", { unit, now, ...(confirm ? { confirm } : {}) });

  return {
    list: (options?: CallOptions) => call<{ units: ServiceSummary[] }>("list", {}, options),
    get: (unit: string, options?: CallOptions) => call<ServiceDetail>("get", { unit }, options),
    cat: (unit: string, options?: CallOptions) => call<{ text: string }>("cat", { unit }, options),
    timers: (options?: CallOptions) => call<{ timers: ServiceTimer[] }>("timers", {}, options),
    logs: (query: ServiceLogQuery, options?: CallOptions) =>
      call<ServiceLogPage>("logs", { ...query }, options),
    action,
    enable,
    disable,
    daemonReload: () => call<{ status: "ok" }>("daemonReload", {}),
    /** Applies one change; the state it left the unit in is known only for actions. */
    async change(
      unit: string,
      change: ServiceChange,
      confirm?: string,
    ): Promise<ServiceChangeResult> {
      if (change.kind === "action") {
        const result = await action(unit, change.action, confirm);
        return { activeState: result.activeState, subState: result.subState };
      }
      if (change.kind === "enable") await enable(unit, change.now);
      else await disable(unit, change.now, confirm);
      return null;
    },
  };
}

export type ServicesClient = ReturnType<typeof servicesClient>;
