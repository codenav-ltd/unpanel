// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { DatabaseSync } from "node:sqlite";

const MINUTE_MS = 60_000;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

export interface HistorySample {
  ratio: number | null;
  memUsed: number;
  memTotal: number;
  diskUsed: number | null;
  diskTotal: number | null;
}

export interface HistorySeries {
  /** Unix milliseconds of the first minute in the window. */
  start: number;
  stepMs: number;
  cpu: (number | null)[];
  mem: (number | null)[];
  disk: (number | null)[];
}

interface MinuteRow {
  ts: number;
  cpu_sum: number;
  cpu_n: number;
  cpu_max: number | null;
  mem_sum: number;
  mem_n: number;
  disk_sum: number;
  disk_n: number;
}

/** One row per minute. Missing readings stay null instead of being stored as zero. */
export function createHistory(
  db: DatabaseSync,
  retainMs: () => number = () => RETAIN_MS,
): {
  record: (nodeId: string, at: number, sample: HistorySample) => void;
  series: (nodeId: string, at: number, minutes: number) => HistorySeries;
} {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics_1m (
      node_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      cpu_sum REAL NOT NULL DEFAULT 0,
      cpu_n INTEGER NOT NULL DEFAULT 0,
      cpu_max REAL,
      mem_sum REAL NOT NULL DEFAULT 0,
      mem_n INTEGER NOT NULL DEFAULT 0,
      disk_sum REAL NOT NULL DEFAULT 0,
      disk_n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (node_id, ts)
    );
  `);
  const readOne = db.prepare(
    `SELECT ts, cpu_sum, cpu_n, cpu_max, mem_sum, mem_n, disk_sum, disk_n
     FROM metrics_1m WHERE node_id = ? AND ts = ?`,
  );
  const write = db.prepare(
    `INSERT INTO metrics_1m (node_id, ts, cpu_sum, cpu_n, cpu_max, mem_sum, mem_n, disk_sum, disk_n)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (node_id, ts) DO UPDATE SET
       cpu_sum = excluded.cpu_sum,
       cpu_n = excluded.cpu_n,
       cpu_max = excluded.cpu_max,
       mem_sum = excluded.mem_sum,
       mem_n = excluded.mem_n,
       disk_sum = excluded.disk_sum,
       disk_n = excluded.disk_n`,
  );
  const readRange = db.prepare(
    `SELECT ts, cpu_sum, cpu_n, cpu_max, mem_sum, mem_n, disk_sum, disk_n
     FROM metrics_1m WHERE node_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`,
  );
  const prune = db.prepare(`DELETE FROM metrics_1m WHERE ts < ?`);

  function record(nodeId: string, at: number, sample: HistorySample): void {
    const ts = Math.floor(at / MINUTE_MS) * MINUTE_MS;
    const current = rowOf(readOne.get(nodeId, ts));
    const cpu = ratioOrNull(sample.ratio);
    const mem = portion(sample.memUsed, sample.memTotal);
    const disk = portion(sample.diskUsed, sample.diskTotal);
    const cpuN = current.cpu_n + (cpu == null ? 0 : 1);
    const memN = current.mem_n + (mem == null ? 0 : 1);
    const diskN = current.disk_n + (disk == null ? 0 : 1);
    const cpuMax =
      cpu == null
        ? current.cpu_max
        : current.cpu_max == null
          ? cpu
          : Math.max(current.cpu_max, cpu);
    write.run(
      nodeId,
      ts,
      current.cpu_sum + (cpu ?? 0),
      cpuN,
      cpuMax,
      current.mem_sum + (mem ?? 0),
      memN,
      current.disk_sum + (disk ?? 0),
      diskN,
    );
    prune.run(ts - retainMs());
  }

  function series(nodeId: string, at: number, minutes: number): HistorySeries {
    const end = Math.floor(at / MINUTE_MS) * MINUTE_MS;
    const start = end - Math.max(0, minutes - 1) * MINUTE_MS;
    const rows = new Map<number, MinuteRow>();
    for (const raw of readRange.all(nodeId, start, end)) {
      const row = rowOf(raw);
      rows.set(row.ts, row);
    }
    const cpu: (number | null)[] = [];
    const mem: (number | null)[] = [];
    const disk: (number | null)[] = [];
    for (let ts = start; ts <= end; ts += MINUTE_MS) {
      const row = rows.get(ts);
      cpu.push(row ? average(row.cpu_sum, row.cpu_n) : null);
      mem.push(row ? average(row.mem_sum, row.mem_n) : null);
      disk.push(row ? average(row.disk_sum, row.disk_n) : null);
    }
    return { start, stepMs: MINUTE_MS, cpu, mem, disk };
  }

  return { record, series };
}

function portion(used: number | null, total: number | null): number | null {
  if (used == null || total == null || total <= 0) return null;
  return Math.min(1, Math.max(0, used / total));
}

function ratioOrNull(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function average(sum: number, count: number): number | null {
  if (count <= 0) return null;
  return sum / count;
}

function rowOf(raw: unknown): MinuteRow {
  const row = (raw ?? {}) as Partial<MinuteRow>;
  return {
    ts: Number(row.ts ?? 0),
    cpu_sum: Number(row.cpu_sum ?? 0),
    cpu_n: Number(row.cpu_n ?? 0),
    cpu_max: row.cpu_max == null ? null : Number(row.cpu_max),
    mem_sum: Number(row.mem_sum ?? 0),
    mem_n: Number(row.mem_n ?? 0),
    disk_sum: Number(row.disk_sum ?? 0),
    disk_n: Number(row.disk_n ?? 0),
  };
}
