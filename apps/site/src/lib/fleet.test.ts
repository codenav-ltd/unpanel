// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { advance, demoFleet, load, needsAttention, RAIL_LENGTH, random } from "./fleet";

describe("demo fleet", () => {
  it("is the same for the same seed, so hydration matches the prerendered page", () => {
    expect(demoFleet(7)).toEqual(demoFleet(7));
  });

  it("fills every online rail and leaves offline servers empty", () => {
    for (const server of demoFleet()) {
      expect(server.cpu).toHaveLength(RAIL_LENGTH);
      if (!server.online) expect(server.cpu.every((value) => value === 0)).toBe(true);
      else expect(server.cpu.every((value) => value >= 1 && value <= 99)).toBe(true);
    }
  });

  it("advances by one sample without changing the rail length", () => {
    const fleet = demoFleet();
    const before = fleet[0]!.cpu.slice(1);
    advance(fleet, random(1));
    expect(fleet[0]!.cpu).toHaveLength(RAIL_LENGTH);
    expect(fleet[0]!.cpu.slice(0, -1)).toEqual(before);
  });

  it("flags offline servers and full disks for attention", () => {
    const flagged = demoFleet()
      .filter(needsAttention)
      .map((server) => server.name);
    expect(flagged).toEqual(["fra-db-2", "home-nas", "lon-mail"]);
  });

  it("uses the panel's load scale", () => {
    expect([59, 60, 84, 85].map(load)).toEqual(["ok", "warn", "warn", "danger"]);
  });
});
