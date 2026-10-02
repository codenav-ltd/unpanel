// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { DatabaseSync } from "node:sqlite";
import { createHistory } from "../apps/panel/src/metrics/history.ts";

const MINUTE_MS = 60_000;
const MAX_ROWS = 2_500_000;
const usage = `Usage: node --import tsx scripts/bench-history.mjs [--nodes 100] [--days 7] [--rounds 5]

Measures the actual history recorder against an in-memory SQLite database.
Options: nodes 1-200, days 1-30, rounds 1-100; at most ${MAX_ROWS.toLocaleString("en-US")} seeded rows.
Each round records one sample per node, with 15 seconds of simulated time between rounds.
Results are diagnostic measurements, not CI performance gates or whole-panel resource budgets.
`;

function optionsFrom(args) {
  const options = { nodes: 100, days: 7, rounds: 5 };
  const limits = { nodes: 200, days: 30, rounds: 100 };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, "");
    if (!args[index]?.startsWith("--") || !Object.hasOwn(limits, name)) {
      throw new Error(`Unknown option: ${args[index] ?? ""}. Run with --help for usage.`);
    }
    const value = Number(args[index + 1]);
    if (!Number.isInteger(value) || value < 1 || value > limits[name]) {
      throw new Error(`--${name} must be an integer from 1 to ${limits[name]}.`);
    }
    options[name] = value;
  }
  if (options.nodes * options.days * 1440 > MAX_ROWS) {
    throw new Error(`This fixture exceeds ${MAX_ROWS} rows. Reduce --nodes or --days.`);
  }
  return options;
}

function milliseconds(value) {
  return Number(value.toFixed(3));
}

function benchmark(options) {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error("This benchmark requires the project's Node 24 runtime.");
  }
  const db = new DatabaseSync(":memory:");
  try {
    const history = createHistory(db, () => options.days * 24 * 60 * MINUTE_MS);
    const base = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    const seedStarted = performance.now();
    db.prepare(
      `WITH RECURSIVE
         minutes(i) AS (VALUES(0) UNION ALL SELECT i + 1 FROM minutes WHERE i < ?),
         nodes(j) AS (VALUES(0) UNION ALL SELECT j + 1 FROM nodes WHERE j < ?)
       INSERT INTO metrics_1m
         (node_id, ts, cpu_sum, cpu_n, cpu_max, mem_sum, mem_n, disk_sum, disk_n)
       SELECT 'node-' || j, ? - i * 60000, 0.4, 1, 0.4, 0.5, 1, 0.25, 1
       FROM minutes CROSS JOIN nodes`,
    ).run(options.days * 1440 - 1, options.nodes - 1, base);
    const seedMs = performance.now() - seedStarted;
    const sample = { ratio: 0.4, memUsed: 50, memTotal: 100, diskUsed: 25, diskTotal: 100 };
    const roundMs = [];
    for (let round = 0; round < options.rounds; round += 1) {
      const started = performance.now();
      for (let node = 0; node < options.nodes; node += 1) {
        history.record(`node-${node}`, base + round * 15_000, sample);
      }
      roundMs.push(performance.now() - started);
    }
    const sorted = [...roundMs].sort((a, b) => a - b);
    const totalMs = roundMs.reduce((sum, value) => sum + value, 0);
    const middle = Math.floor(sorted.length / 2);
    const medianMs =
      sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
    return {
      runtime: process.version,
      platform: process.platform,
      architecture: process.arch,
      database: "SQLite :memory:",
      nodes: options.nodes,
      days: options.days,
      rounds: options.rounds,
      simulatedRoundIntervalMs: 15_000,
      seededRows: options.nodes * options.days * 1440,
      rowsAfterRecording: Number(db.prepare("SELECT COUNT(*) AS n FROM metrics_1m").get().n),
      seedMs: milliseconds(seedMs),
      recordRoundMs: roundMs.map(milliseconds),
      recordTotalMs: milliseconds(totalMs),
      recordMeanMs: milliseconds(totalMs / roundMs.length),
      recordMedianMs: milliseconds(medianMs),
      recordMaxMs: milliseconds(sorted[sorted.length - 1]),
      pruneQueryPlan: db
        .prepare("EXPLAIN QUERY PLAN DELETE FROM metrics_1m WHERE ts < ?")
        .all(base - options.days * 24 * 60 * MINUTE_MS)
        .map((row) => String(row.detail)),
      scope:
        "History recording and retention only; excludes network, disk I/O, panel and agent RSS/CPU.",
    };
  } finally {
    db.close();
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(usage);
  } else {
    process.stdout.write(`${JSON.stringify(benchmark(optionsFrom(args)), null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "History benchmark failed."}\n`);
  process.exitCode = 1;
}
