// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import {
  coreRatios,
  countSocketRows,
  cpuRatio,
  netRates,
  netTotals,
  readLoadAvg,
  readNetDev,
  readSwapInfo,
} from "./cpu.ts";

describe("cpuRatio", () => {
  it("needs a previous sample, then reports the busy share", () => {
    expect(cpuRatio(null, { idle: 100, total: 200 })).toBeNull();
    expect(cpuRatio({ idle: 100, total: 200 }, { idle: 150, total: 300 })).toBeCloseTo(0.5);
  });
});

describe("coreRatios", () => {
  it("waits until the logical CPU count matches", () => {
    const current = [
      { idle: 50, total: 100 },
      { idle: 80, total: 100 },
    ];
    expect(coreRatios(null, current)).toEqual([null, null]);
    expect(coreRatios([{ idle: 0, total: 10 }], current)).toEqual([null, null]);
    const ratios = coreRatios(
      [
        { idle: 0, total: 0 },
        { idle: 0, total: 0 },
      ],
      current,
    );
    expect(ratios[0]).toBeCloseTo(0.5);
    expect(ratios[1]).toBeCloseTo(0.2);
  });
});

describe("readLoadAvg", () => {
  it("reads the three load fields", () => {
    expect(readLoadAvg("0.12 0.08 0.05 1/200 1234\n")).toEqual({
      load1: 0.12,
      load5: 0.08,
      load15: 0.05,
    });
    expect(readLoadAvg("not a load")).toBeNull();
  });
});

describe("netRates", () => {
  const dev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 100 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0
  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0
 veth1: 99999 0 0 0 0 0 0 0 99999 0 0 0 0 0 0 0
`;

  it("counts metered interfaces and ignores a counter reset", () => {
    const first = readNetDev(dev);
    expect(Object.keys(first)).toEqual(["eth0"]);
    const second = readNetDev(dev.replace("eth0: 1000", "eth0: 5000").replace("2000", "4000"));
    expect(netRates(null, second, 2000)).toBeNull();
    expect(netRates(first, second, 2000)).toEqual({ rxBps: 2000, txBps: 1000 });
    const wrapped = readNetDev(dev.replace("eth0: 1000", "eth0: 10"));
    expect(netRates(first, wrapped, 2000)).toBeNull();
  });

  it("totals only the metered interfaces", () => {
    expect(netTotals(readNetDev(dev))).toEqual({ rx: 1000, tx: 2000 });
  });
});

describe("countSocketRows", () => {
  it("skips the header and blank lines", () => {
    const table = `  sl  local_address rem_address   st tx_queue rx_queue
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000
   1: 0100007F:1F91 00000000:0000 01 00000000:00000000
`;
    expect(countSocketRows(table)).toBe(2);
    expect(countSocketRows("")).toBe(0);
  });
});

describe("readSwapInfo", () => {
  it("reads swap kilobytes from meminfo", () => {
    const text = "MemTotal: 100 kB\nSwapTotal: 2048 kB\nSwapFree: 1024 kB\n";
    expect(readSwapInfo(text)).toEqual({ used: 1024 * 1024, total: 2048 * 1024 });
    expect(readSwapInfo("MemTotal: 100 kB\n")).toBeNull();
  });
});
