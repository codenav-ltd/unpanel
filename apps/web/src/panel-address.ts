// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { en } from "./i18n/en.ts";

/** One remote node's answer to a new panel address, as the settings API reports it. */
export interface EndpointReport {
  nodeId: string;
  name: string;
  outcome: "reached" | "saved" | "offline" | "outdated" | "failed";
  detail?: string;
}

export interface EndpointRow {
  nodeId: string;
  name: string;
  label: string;
  tone: "ok" | "warning" | "error";
  text: string;
}

/** True for an address agents can only find by IP, which a sudden IP change breaks. */
export function addressUsesIp(address: string): boolean {
  try {
    const host = new URL(address.trim()).hostname;
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
  } catch {
    return false;
  }
}

export function endpointRows(reports: readonly EndpointReport[]): EndpointRow[] {
  const copy = en.shell.endpoint;
  return reports.map((report) => {
    const base = { nodeId: report.nodeId, name: report.name || report.nodeId };
    switch (report.outcome) {
      case "reached":
        return { ...base, label: copy.reached, tone: "ok", text: copy.reachedText };
      case "saved":
        return {
          ...base,
          label: copy.saved,
          tone: "warning",
          text: report.detail ? `${report.detail} ${copy.savedText}` : copy.savedText,
        };
      case "offline":
        return { ...base, label: copy.offline, tone: "warning", text: copy.offlineText };
      case "outdated":
        return { ...base, label: copy.outdated, tone: "error", text: copy.outdatedText };
      case "failed":
        return {
          ...base,
          label: copy.failed,
          tone: "error",
          text: report.detail ?? copy.failedText,
        };
    }
  });
}
