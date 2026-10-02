// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export type PanelUpdateOutcome =
  | { kind: "updated"; version: string }
  | { kind: "rolled-back"; version: string }
  | { kind: "timeout"; version: string | null };

interface HealthReply {
  version?: unknown;
}

/**
 * Waits across the panel restart. Two consecutive unreachable probes followed
 * by the old version means the rollback path brought the previous panel back.
 */
export async function waitForPanelUpdate(
  targetVersion: string,
  options: {
    fetchImpl?: typeof fetch;
    wait?: () => Promise<void>;
    attempts?: number;
  } = {},
): Promise<PanelUpdateOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.wait ?? (() => new Promise((resolve) => setTimeout(resolve, 1_000)));
  const attempts = options.attempts ?? 120;
  let consecutiveUnavailable = 0;
  let outageConfirmed = false;
  let lastVersion: string | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait();
    try {
      const response = await fetchImpl("/api/v1/health", {
        cache: "no-store",
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        consecutiveUnavailable += 1;
        outageConfirmed ||= consecutiveUnavailable >= 2;
        continue;
      }
      const body = (await response.json()) as HealthReply;
      const version = typeof body.version === "string" ? body.version : null;
      if (version === targetVersion) return { kind: "updated", version };
      lastVersion = version;
      if (outageConfirmed && version) return { kind: "rolled-back", version };
      consecutiveUnavailable = 0;
    } catch {
      consecutiveUnavailable += 1;
      outageConfirmed ||= consecutiveUnavailable >= 2;
    }
  }

  return { kind: "timeout", version: lastVersion };
}

export function updateResultVersion(search: string, runningVersion: string): string {
  const version = new URLSearchParams(search).get("updated")?.trim() ?? "";
  return version === runningVersion ? version : "";
}
