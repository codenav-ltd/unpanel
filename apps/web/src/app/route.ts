// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { ShellPage } from "../components/AppSidebar.vue";

export type SettingsSection = "panel" | "security" | "updates" | "about";

export interface ShellLocation {
  page: ShellPage;
  nodeId: string;
  settings: SettingsSection;
  /** Set when the path is not a page, so the shell can say where it sent the user. */
  unknown: string | null;
}

/** The shell used to keep its page in memory, so a refresh always opened the overview. */
export function parsePath(path: string): ShellLocation {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "alerts") {
    return { page: "alerts", nodeId: "local", settings: "panel", unknown: null };
  }
  if (parts.length === 1 && parts[0] === "certificates") {
    return { page: "certificates", nodeId: "local", settings: "panel", unknown: null };
  }
  if (parts[0] === "settings") {
    const settings: SettingsSection =
      parts[1] === "security" || parts[1] === "updates" || parts[1] === "about"
        ? parts[1]
        : "panel";
    return { page: "settings", nodeId: "local", settings, unknown: null };
  }
  if (parts[0] === "nodes" && parts[1]) {
    let nodeId: string;
    try {
      nodeId = decodeURIComponent(parts[1]);
    } catch {
      return { page: "overview", nodeId: "local", settings: "panel", unknown: path };
    }
    return {
      page: parts[2] === "host" ? "host" : "dashboard",
      nodeId,
      settings: "panel",
      unknown: null,
    };
  }
  if (parts.length === 0) {
    return { page: "overview", nodeId: "local", settings: "panel", unknown: null };
  }
  return { page: "overview", nodeId: "local", settings: "panel", unknown: path };
}

export function formatPath(location: ShellLocation): string {
  if (location.page === "alerts") return "/alerts";
  if (location.page === "certificates") return "/certificates";
  if (location.page === "settings") {
    return location.settings === "panel" ? "/settings" : `/settings/${location.settings}`;
  }
  if (location.page === "dashboard" || location.page === "host") {
    const id = encodeURIComponent(location.nodeId || "local");
    return location.page === "host" ? `/nodes/${id}/host` : `/nodes/${id}`;
  }
  return "/";
}
