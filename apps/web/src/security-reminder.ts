// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { SecurityUpdateStatus } from "@unpanel/shared";
export function securityPromptKey(status: SecurityUpdateStatus): string {
  return JSON.stringify(
    status.advisories
      .filter((a) => a.severity === "critical")
      .map((a) => [a.id, a.title, a.fixedVersion, a.deadline ?? ""])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}
export function shouldPromptSecurity(
  status: SecurityUpdateStatus,
  saved: unknown,
  now = Date.now(),
): boolean {
  if (!status.advisories.some((a) => a.severity === "critical")) return false;
  if (!saved || typeof saved !== "object") return true;
  const record = saved as Record<string, unknown>;
  return (
    record["key"] !== securityPromptKey(status) ||
    typeof record["until"] !== "number" ||
    record["until"] <= now ||
    record["until"] > now + 3_600_000
  );
}
