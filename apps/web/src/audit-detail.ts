// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** The sentence Logs shows. A code alone is only the fallback for older rows. */
export function auditDetail(entry: {
  target: string | null;
  errorCode: string | null;
  params: Record<string, unknown> | null;
}): string {
  const detail =
    entry.params && typeof entry.params["detail"] === "string" ? entry.params["detail"] : "";
  if (detail) {
    return entry.errorCode && !detail.includes(entry.errorCode)
      ? `${detail} (${entry.errorCode})`
      : detail;
  }
  return [entry.target, entry.errorCode].filter(Boolean).join(" · ");
}
