// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { readProblem, replyNotReceived } from "./http-error.ts";

export class AlertRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function alertRequest<T>(
  path = "",
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/alerts${path}`, {
      method,
      ...(signal ? { signal } : {}),
      ...(method === "GET" || method === "DELETE"
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }),
    });
  } catch {
    throw new Error(
      method === "GET"
        ? "Could not load alerts. Check your connection and try again."
        : replyNotReceived(
            "update alerts",
            "Reload Alerts to check whether the change was saved before trying again.",
          ),
    );
  }
  if (!response.ok)
    throw new AlertRequestError(await readProblem(response, "update alerts"), response.status);
  return ((await response.json()) as { data: T }).data;
}
export const alertMetrics = [
  { value: "offline", label: "Node goes offline" },
  { value: "cpu", label: "CPU usage" },
  { value: "memory", label: "Memory usage" },
  { value: "disk", label: "System disk usage" },
  { value: "swap", label: "Swap usage" },
  { value: "certificate", label: "Panel certificate expires" },
] as const;
export const alertSeverities = [
  { value: "warning", label: "Warning and critical" },
  { value: "critical", label: "Critical only" },
] as const;
