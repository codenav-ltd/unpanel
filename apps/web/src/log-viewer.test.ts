// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import {
  appendEntries,
  downloadName,
  formatLogTime,
  isNearBottom,
  linesText,
  priorityParam,
  priorityTone,
  rangeSince,
  sourceOf,
} from "./log-viewer.ts";
import type { ServiceLogEntry } from "./services-client.ts";

const entry = (n: number, patch: Partial<ServiceLogEntry> = {}): ServiceLogEntry => ({
  cursor: `c${n}`,
  ts: n,
  priority: 6,
  pid: null,
  identifier: null,
  message: `line ${n}`,
  ...patch,
});

describe("appendEntries", () => {
  it("adds newer entries and ignores cursors it already holds", () => {
    const first = appendEntries([], [entry(1), entry(2)], 10);
    expect(first).toMatchObject({ added: 2, dropped: 0 });
    const next = appendEntries(first.entries, [entry(2), entry(3)], 10);
    expect(next.entries.map((row) => row.cursor)).toEqual(["c1", "c2", "c3"]);
    expect(next.added).toBe(1);
  });

  it("drops the oldest entries beyond the cap and says how many", () => {
    const buffer = [entry(1), entry(2), entry(3)];
    const result = appendEntries(buffer, [entry(4), entry(5)], 4);
    expect(result.entries.map((row) => row.cursor)).toEqual(["c2", "c3", "c4", "c5"]);
    expect(result.dropped).toBe(1);
  });

  it("returns the same buffer when nothing came in", () => {
    const buffer = [entry(1)];
    expect(appendEntries(buffer, []).entries).toBe(buffer);
  });
});

describe("priority", () => {
  it("tones severities for both themes through tokens", () => {
    expect([0, 3, 4, 5, 6, 7, null].map(priorityTone)).toEqual([
      "danger",
      "danger",
      "warn",
      "default",
      "default",
      "muted",
      "default",
    ]);
  });

  it("turns the picker value into the request's priority", () => {
    expect(priorityParam("all")).toBeUndefined();
    expect(priorityParam("4")).toBe(4);
  });
});

describe("time", () => {
  const now = new Date(2026, 10, 6, 14, 30, 0).getTime();

  it("shows the clock for today and the date before it", () => {
    expect(formatLogTime(new Date(2026, 10, 6, 9, 5, 7).getTime(), now)).toBe("09:05:07");
    expect(formatLogTime(new Date(2026, 10, 5, 23, 59, 1).getTime(), now)).toBe("Nov 5 23:59:01");
  });

  it("measures a range back from now", () => {
    expect(rangeSince("any", now)).toBeUndefined();
    expect(rangeSince("1h", now)).toBe(now - 3_600_000);
  });

  it("names a download after the unit and the moment", () => {
    expect(downloadName(["nginx.service"], now)).toBe("nginx.service-20261106-143000.log");
    expect(downloadName(["a.service", "b.service"], now)).toBe("journal-20261106-143000.log");
  });
});

describe("text", () => {
  const units = ["nginx.service"];

  it("omits the program when it is the unit itself", () => {
    expect(sourceOf(entry(1, { identifier: "nginx", pid: 12 }), units)).toBe("");
    expect(sourceOf(entry(1, { identifier: "systemd", pid: 1 }), units)).toBe("systemd[1]");
    expect(
      sourceOf(entry(1, { identifier: "nginx", pid: 12 }), ["a.service", "nginx.service"]),
    ).toBe("nginx[12]");
  });

  it("copies one line per entry, tagging everything but info", () => {
    const text = linesText(
      [entry(1, { priority: 3, message: "boom" }), entry(2, { identifier: "systemd", pid: 1 })],
      units,
    );
    const [first, second] = text.split("\n");
    expect(first).toMatch(/ ERR boom$/);
    expect(second).toMatch(/ systemd\[1\]: line 2$/);
  });
});

describe("isNearBottom", () => {
  it("allows a little slack for sub-pixel scrolling", () => {
    expect(isNearBottom({ scrollTop: 976, scrollHeight: 1500, clientHeight: 500 })).toBe(true);
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1500, clientHeight: 500 })).toBe(false);
  });
});
