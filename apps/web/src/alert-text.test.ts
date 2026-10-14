// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { humanDuration, ruleCondition, ruleScope, timeAgo } from "./alert-text.ts";

describe("alert text", () => {
  it("reads durations in the largest whole unit", () => {
    expect(humanDuration(45)).toBe("45 s");
    expect(humanDuration(90)).toBe("90 s");
    expect(humanDuration(120)).toBe("2 min");
    expect(humanDuration(5400)).toBe("90 min");
    expect(humanDuration(7200)).toBe("2 h");
  });

  it("writes each kind of rule as one sentence", () => {
    expect(ruleCondition({ metric: "memory", threshold: 95, durationSeconds: 300 })).toBe(
      "Memory ≥ 95% for 5 min",
    );
    expect(ruleCondition({ metric: "offline", threshold: 1, durationSeconds: 120 })).toBe(
      "Node offline for 2 min",
    );
    expect(ruleCondition({ metric: "certificate", threshold: 1, durationSeconds: 0 })).toBe(
      "Panel certificate expires within 1 day",
    );
    expect(ruleCondition({ metric: "disk", threshold: 97, durationSeconds: 0 })).toBe(
      "System disk ≥ 97%",
    );
  });

  it("names what a rule covers", () => {
    const nodes = [{ id: "a", name: "web-01" }];
    expect(ruleScope({ metric: "cpu", nodeIds: [] }, nodes)).toBe("All nodes");
    expect(ruleScope({ metric: "cpu", nodeIds: ["a"] }, nodes)).toBe("web-01");
    expect(ruleScope({ metric: "cpu", nodeIds: ["a", "b"] }, nodes)).toBe("2 nodes");
    expect(ruleScope({ metric: "certificate", nodeIds: [] }, nodes)).toBe("This panel");
  });

  it("says how long ago", () => {
    const now = 1_000_000_000;
    expect(timeAgo(now - 20_000, now)).toBe("just now");
    expect(timeAgo(now - 12 * 60_000, now)).toBe("12 min ago");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(timeAgo(now - 72 * 3_600_000, now)).toBe("3 d ago");
  });
});
