// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** One container as the alert engine sees it. */
export interface ContainerHealth {
  name: string;
  /** Null while a new failure waits for the next poll, since `--rm` jobs pass through dead. */
  down: boolean | null;
  /** Completes "Container web …": "stopped with exit code 1". */
  note: string;
}

interface Row {
  Id: string;
  Names: string[];
  State: string;
  Status: string;
}

const POLL_MS = 30_000;
const FRESH_MS = 90_000;

/** "Exited (137) 2 hours ago" → 137. */
function exitCode(status: string): number | null {
  const match = /\((\d+)\)/.exec(status);
  return match?.[1] ? Number(match[1]) : null;
}

/** Docker words the age; anything a day or older happened before anyone was watching. */
function recent(status: string): boolean {
  return !/\b(days?|weeks?|months?|years?) ago$/.test(status);
}

/**
 * Which containers to watch and whether each is down. A container that finished cleanly, was
 * stopped from Unpanel, or failed long before it was ever seen running is not watched.
 */
export function classify(
  row: Row,
  seenRunning: boolean,
  stoppedHere: boolean,
): ContainerHealth | null {
  const name = (row.Names[0] ?? row.Id.slice(0, 12)).replace(/^\//, "");
  switch (row.State) {
    case "running":
      return /\(unhealthy\)/.test(row.Status)
        ? { name, down: true, note: "is running but failing its health check" }
        : { name, down: false, note: "is running" };
    case "restarting": {
      const code = exitCode(row.Status);
      return {
        name,
        down: true,
        note: `keeps restarting${code === null ? "" : ` (last exit code ${code})`}`,
      };
    }
    case "exited":
    case "dead": {
      if (stoppedHere) return null;
      const code = exitCode(row.Status);
      if (row.State === "exited" && (code === 0 || (!seenRunning && !recent(row.Status))))
        return null;
      return {
        name,
        down: true,
        note: row.State === "dead" ? "is dead" : `stopped with exit code ${code ?? "unknown"}`,
      };
    }
    default:
      // Created, paused or being removed: someone is handling it.
      return null;
  }
}

/**
 * Polls container lists from nodes that a container rule watches, so the synchronous engine
 * tick can read the latest state. Uses the agents' existing Docker list, so older agents work.
 */
export function createContainerWatch(options: {
  list: (nodeId: string) => Promise<unknown>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const latest = new Map<string, { at: number; containers: ContainerHealth[] }>();
  const polledAt = new Map<string, number>();
  const busy = new Set<string>();
  const seenRunning = new Set<string>();
  const stoppedHere = new Set<string>();
  /** Containers each node's last poll found down, by `<node>:<id>`. */
  const downBefore = new Map<string, Set<string>>();

  async function poll(nodeId: string): Promise<void> {
    busy.add(nodeId);
    polledAt.set(nodeId, now());
    try {
      const rows = (await options.list(nodeId)) as Row[];
      const containers: ContainerHealth[] = [];
      const before = downBefore.get(nodeId);
      const down = new Set<string>();
      for (const row of rows) {
        const key = `${nodeId}:${row.Id}`;
        if (row.State === "running") {
          seenRunning.add(key);
          stoppedHere.delete(key);
        }
        const health = classify(row, seenRunning.has(key), stoppedHere.has(key));
        if (health?.down) {
          down.add(key);
          if (!before?.has(key)) health.down = null;
        }
        if (health) containers.push(health);
      }
      downBefore.set(nodeId, down);
      latest.set(nodeId, { at: now(), containers });
    } catch {
      // Docker missing or the node unreachable: readings go stale and the engine waits.
    } finally {
      busy.delete(nodeId);
    }
  }

  return {
    /** Starts a refresh for each node that is due; results arrive by a later tick. */
    refresh(nodeIds: readonly string[]): void {
      for (const id of nodeIds)
        if (!busy.has(id) && now() - (polledAt.get(id) ?? -Infinity) >= POLL_MS) void poll(id);
    },
    /** The last list from this node, and whether it is recent enough to judge by. */
    read(nodeId: string): { fresh: boolean; containers: ContainerHealth[] } | null {
      const entry = latest.get(nodeId);
      return entry ? { fresh: now() - entry.at <= FRESH_MS, containers: entry.containers } : null;
    },
    /** A stop or pause from Unpanel's Docker page is intended, not an outage. */
    stopped(nodeId: string, containerId: string): void {
      stoppedHere.add(`${nodeId}:${containerId}`);
      polledAt.delete(nodeId);
    },
    /** Re-check soon after a start or restart from Unpanel. */
    changed(nodeId: string): void {
      polledAt.delete(nodeId);
    },
  };
}
export type ContainerWatch = ReturnType<typeof createContainerWatch>;
