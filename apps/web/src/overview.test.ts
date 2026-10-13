// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { attention, needsAttention, sortForOverview, type OverviewNode } from "./overview.ts";

const node = (name: string, extra: Partial<OverviewNode> = {}): OverviewNode => ({
  name,
  hostname: null,
  status: "active",
  online: true,
  cpuRatio: 0.1,
  memRatio: 0.2,
  diskRatio: 0.3,
  ...extra,
});

describe("overview attention", () => {
  it("names the readings over threshold, highest first", () => {
    expect(attention(node("a", { memRatio: 0.99, diskRatio: 0.7 }))).toEqual({
      level: "danger",
      reasons: ["Memory 99%", "Storage 70%"],
    });
    expect(attention(node("b", { cpuRatio: 0.65 }))).toEqual({
      level: "warn",
      reasons: ["CPU 65%"],
    });
    expect(attention(node("c"))).toEqual({ level: "ok", reasons: [] });
  });

  it("treats unknown readings as nothing to report, not zero", () => {
    expect(attention(node("d", { cpuRatio: null, memRatio: null, diskRatio: null }))).toEqual({
      level: "ok",
      reasons: [],
    });
  });

  it("does not count disabled or waiting nodes as needing attention", () => {
    expect(needsAttention(node("e", { status: "disabled", online: false }))).toBe(false);
    expect(needsAttention(node("f", { status: "pending", online: false }))).toBe(false);
    expect(needsAttention(node("g", { online: false }))).toBe(true);
  });

  it("sorts offline, then overloaded, then healthy, then inactive nodes", () => {
    const sorted = sortForOverview([
      node("healthy-b"),
      node("disabled", { status: "disabled", online: false }),
      node("warn", { cpuRatio: 0.7 }),
      node("healthy-a"),
      node("offline", { online: false }),
      node("danger", { diskRatio: 0.95 }),
    ]);
    expect(sorted.map((item) => item.name)).toEqual([
      "offline",
      "danger",
      "warn",
      "healthy-a",
      "healthy-b",
      "disabled",
    ]);
  });
});
