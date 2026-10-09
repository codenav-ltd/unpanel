// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export type PanelUpdateOutcome =
  | { kind: "updated"; version: string }
  | { kind: "rolled-back"; version: string }
  | { kind: "timeout"; version: string | null };

interface HealthReply {
  version?: unknown;
}

/** Poll readiness promptly; only an observed update trace can prove rollback. */
export async function waitForPanelUpdate(
  targetVersion: string,
  options: {
    fetchImpl?: typeof fetch;
    wait?: (milliseconds: number) => Promise<void>;
    attempts?: number;
    signal?: AbortSignal;
    previousOperationIds?: readonly string[];
  } = {},
): Promise<PanelUpdateOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait =
    options.wait ??
    ((ms) =>
      new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, ms);
        options.signal?.addEventListener("abort", finish, { once: true });
        if (options.signal?.aborted) finish();
      }));
  const deadline = Date.now() + 120_000;
  const attempts = options.attempts ?? Infinity;
  let operationId: string | null = null;
  const previousIds = options.previousOperationIds ? new Set(options.previousOperationIds) : null;
  let nextHistoryCheck = 0;
  let lastVersion: string | null = null;

  for (let attempt = 0; attempt < attempts && Date.now() < deadline; attempt += 1) {
    if (options.signal?.aborted) break;
    if (attempt > 0) await wait(Math.min(250, deadline - Date.now()));
    if (options.signal?.aborted || Date.now() >= deadline) break;
    try {
      const timeout = AbortSignal.timeout(Math.min(1_000, deadline - Date.now()));
      const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
      const response = await fetchImpl("/api/v1/health", {
        cache: "no-store",
        signal,
      });
      if (!response.ok) continue;
      const body = (await response.json()) as HealthReply;
      const version = typeof body.version === "string" ? body.version : null;
      if (version === targetVersion) return { kind: "updated", version };
      lastVersion = version;
      if (version && Date.now() >= nextHistoryCheck) {
        nextHistoryCheck = Date.now() + 1_000;
        const history = await fetchImpl("/api/v1/updates/history", { cache: "no-store", signal });
        if (!history.ok) continue;
        const body = (await history.json()) as {
          data?: Array<{ id: string; to: string; status: string }>;
        };
        const operation = Array.isArray(body.data)
          ? body.data.find((entry) => entry.to === targetVersion)
          : undefined;
        if (operation?.status === "running") operationId = operation.id;
        if (
          operation?.status === "rolled-back" &&
          (operation.id === operationId || (previousIds && !previousIds.has(operation.id)))
        ) {
          return { kind: "rolled-back", version };
        }
      }
    } catch {
      // Restart and transient network failures are expected; keep probing.
    }
  }

  return { kind: "timeout", version: lastVersion };
}

export function updateResultVersion(search: string, runningVersion: string): string {
  const version = new URLSearchParams(search).get("updated")?.trim() ?? "";
  return version === runningVersion ? version : "";
}
