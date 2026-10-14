// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { compareVersions } from "@unpanel/shared";

export interface RolloutNode {
  id: string;
  status: "pending" | "active" | "disabled";
  online: boolean;
  agentVersion: string | null;
  canUpdateAgent: boolean;
}

export interface RolloutPlan<T extends RolloutNode> {
  /** Online agents behind the panel that can update themselves, in list order. */
  ready: T[];
  /** Behind but offline; they can be updated once they reconnect. */
  offline: T[];
  /** Behind and too old to update themselves; they need the manual steps. */
  manual: T[];
}

/** Splits the agents that are behind the panel by what “Update all” can do for them. */
export function rolloutPlan<T extends RolloutNode>(
  nodes: readonly T[],
  panelVersion: string,
): RolloutPlan<T> {
  const behind = nodes.filter(
    (node) =>
      node.status === "active" &&
      node.agentVersion !== null &&
      (compareVersions(node.agentVersion, panelVersion) ?? 0) < 0,
  );
  return {
    ready: behind.filter((node) => node.online && node.canUpdateAgent),
    offline: behind.filter((node) => !node.online && node.canUpdateAgent),
    manual: behind.filter((node) => !node.canUpdateAgent),
  };
}
