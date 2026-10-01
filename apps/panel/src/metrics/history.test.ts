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
    expect(series.cpu[0]).toBeCloseTo(0.6);
    expect(series.mem[0]).toBeCloseTo(0.65);
    expect(series.disk[0]).toBeCloseTo(0.25);
    expect(series.cpu[1]).toBeCloseTo(0.1);
    expect(series.disk[1]).toBeNull();
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
    expect(history.series("local", 60_000, 60)).toEqual({
      cpu: [null],
      mem: [0.5],
      disk: [null],
    });
  });
});
