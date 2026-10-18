// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { EndpointUpdateResult } from "@unpanel/protocol";
import type { NodeRecord } from "./store.ts";

/**
 * What one remote node did with the panel's address (design/03 §11):
 * reached it, saved it without reaching it yet, missed it while offline,
 * runs an agent that cannot take it, or refused it.
 */
export type EndpointOutcome = "reached" | "saved" | "offline" | "outdated" | "failed";

export interface EndpointReport {
  nodeId: string;
  name: string;
  outcome: EndpointOutcome;
  /** Why the address was not reached or saved, in the agent's or panel's words. */
  detail?: string;
}

export interface EndpointTarget {
  /** The panel's `/_agent/ws` address. */
  url: string;
  /** The self-signed certificate agents need to trust the panel, when it serves one. */
  tlsCa?: string;
}

export function createEndpointAnnouncer(options: {
  nodes: () => NodeRecord[];
  /** Addresses a connected agent reports; null when it is offline or cannot take an update. */
  endpointUrls: (nodeId: string) => readonly string[] | null;
  online: (nodeId: string) => boolean;
  send: (nodeId: string, target: EndpointTarget) => Promise<EndpointUpdateResult>;
  target: () => EndpointTarget | null;
  record: (report: EndpointReport, target: EndpointTarget) => void;
}): {
  /** Sends the current address to every remote node and reports each one. */
  announceAll: () => Promise<EndpointReport[]>;
  /** Resends the address to one connected node that still dials an older one. */
  sync: (nodeId: string) => void;
} {
  const inflight = new Set<string>();

  async function announce(node: NodeRecord, target: EndpointTarget): Promise<EndpointReport> {
    const base = { nodeId: node.id, name: node.name };
    if (!options.online(node.id)) return { ...base, outcome: "offline" };
    if (options.endpointUrls(node.id) === null) return { ...base, outcome: "outdated" };
    try {
      const result = await options.send(node.id, target);
      return result.reachable
        ? { ...base, outcome: "reached" }
        : { ...base, outcome: "saved", ...(result.error ? { detail: result.error } : {}) };
    } catch (error) {
      return {
        ...base,
        outcome: "failed",
        detail: error instanceof Error ? error.message : "The agent did not accept the address.",
      };
    }
  }

  async function run(node: NodeRecord, target: EndpointTarget): Promise<EndpointReport> {
    inflight.add(node.id);
    try {
      const report = await announce(node, target);
      if (report.outcome !== "offline" && report.outcome !== "outdated")
        options.record(report, target);
      return report;
    } finally {
      inflight.delete(node.id);
    }
  }

  const remote = (): NodeRecord[] =>
    options.nodes().filter((node) => node.transport === "wss" && node.status === "active");

  return {
    async announceAll() {
      const target = options.target();
      if (!target) return [];
      return Promise.all(remote().map((node) => run(node, target)));
    },
    sync(nodeId) {
      const target = options.target();
      const urls = options.endpointUrls(nodeId);
      const node = remote().find((candidate) => candidate.id === nodeId);
      if (!target || !node || !urls || urls[0] === target.url || inflight.has(nodeId)) return;
      void run(node, target);
    },
  };
}

/** The WebSocket address agents dial for a panel served at `publicUrl`. */
export function agentWsUrl(publicUrl: string): string {
  if (!publicUrl) return "";
  const url = new URL(publicUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/_agent/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}
