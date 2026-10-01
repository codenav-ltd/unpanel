// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createHistory } from "./history.ts";

const sample = {
  ratio: 0.4,
  memUsed: 50,
  memTotal: 100,
  diskUsed: 25,
  diskTotal: 100,
};

describe("createHistory", () => {
  it("averages samples inside a minute and keeps a later minute", () => {
    const db = new DatabaseSync(":memory:");
    const history = createHistory(db);
    const minute = 1_700_000_000_000;
    history.record("local", minute + 1_000, sample);
    history.record("local", minute + 20_000, { ...sample, ratio: 0.8, memUsed: 80 });
    history.record("local", minute + 60_000, {
      ...sample,
      ratio: 0.1,
      diskUsed: null,
      diskTotal: null,
    });

    const series = history.series("local", minute + 60_000, 60);
    expect(series.cpu).toHaveLength(60);
    const end = Math.floor((minute + 60_000) / 60_000) * 60_000;
    expect(series.start).toBe(end - 59 * 60_000);
    expect(series.stepMs).toBe(60_000);
    expect(series.cpu[58]).toBeCloseTo(0.6);
    expect(series.mem[58]).toBeCloseTo(0.65);
    expect(series.disk[58]).toBeCloseTo(0.25);
    expect(series.cpu[59]).toBeCloseTo(0.1);
    expect(series.disk[59]).toBeNull();
    expect(series.cpu[0]).toBeNull();
  });

  it("keeps a missing minute in place so the axis stays in time", () => {
    const db = new DatabaseSync(":memory:");
    const history = createHistory(db);
    history.record("local", 120_000, sample);
    const series = history.series("local", 180_000, 3);
    expect(series.start).toBe(60_000);
    expect(series.cpu[0]).toBeNull();
    expect(series.cpu[1]).toBeCloseTo(0.4);
    expect(series.cpu[2]).toBeNull();
  });

  it("does not invent a zero when the reading is missing", () => {
    const db = new DatabaseSync(":memory:");
    const history = createHistory(db);
    history.record("local", 60_000, {
      ratio: null,
      memUsed: 1,
      memTotal: 2,
      diskUsed: null,
      diskTotal: null,
    });
    const series = history.series("local", 60_000, 60);
    expect(series.cpu.at(-1)).toBeNull();
    expect(series.mem.at(-1)).toBe(0.5);
    expect(series.disk.at(-1)).toBeNull();
    expect(series.cpu[0]).toBeNull();
  });

  it("drops minutes older than the saved retention", () => {
    const db = new DatabaseSync(":memory:");
    const history = createHistory(db, () => 60_000);
    history.record("local", 60_000, sample);
    history.record("local", 180_000, sample);
    const series = history.series("local", 180_000, 3);
    expect(series.cpu[0]).toBeNull();
    expect(series.cpu[2]).toBeCloseTo(0.4);
  });
});
