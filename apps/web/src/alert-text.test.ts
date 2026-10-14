// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { humanDuration, incidentNode, ruleCondition, ruleScope, timeAgo } from "./alert-text.ts";

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

  it("states both levels of a two-level rule", () => {
    expect(
      ruleCondition({
        metric: "memory",
        threshold: 90,
        durationSeconds: 180,
        warning: { threshold: 80, durationSeconds: 300 },
      }),
    ).toBe("Memory: warning ≥ 80% for 5 min, critical ≥ 90% for 3 min");
    expect(
      ruleCondition({
        metric: "offline",
        threshold: 1,
        durationSeconds: 300,
        warning: { threshold: 1, durationSeconds: 60 },
      }),
    ).toBe("Node offline: warning after 1 min, critical after 5 min");
    expect(
      ruleCondition({
        metric: "certificate",
        threshold: 7,
        durationSeconds: 0,
        warning: { threshold: 21, durationSeconds: 0 },
      }),
    ).toBe("Panel certificate: warning at 21 days left, critical at 7 days");
  });

  it("writes container, inode and forecast rules", () => {
    expect(
      ruleCondition({
        metric: "container",
        threshold: 1,
        durationSeconds: 300,
        warning: { threshold: 1, durationSeconds: 0 },
      }),
    ).toBe("Container down: warning immediately, critical after 5 min");
    expect(
      ruleCondition({
        metric: "disk_forecast",
        threshold: 12,
        durationSeconds: 900,
        warning: { threshold: 72, durationSeconds: 1800 },
      }),
    ).toBe("System disk full within: warning 72 hours, critical 12 hours");
    expect(ruleCondition({ metric: "inodes", threshold: 90, durationSeconds: 300 })).toBe(
      "Disk inodes ≥ 90% for 5 min",
    );
  });

  it("finds the node behind a container incident", () => {
    expect(incidentNode("nd_1")).toEqual({ nodeId: "nd_1", href: "/nodes/nd_1" });
    expect(incidentNode("nd_1:container:web")).toEqual({
      nodeId: "nd_1",
      href: "/nodes/nd_1/docker",
    });
  });

  it("writes the new conditions in their own units", () => {
    expect(
      ruleCondition({
        metric: "network_in",
        threshold: 800,
        durationSeconds: 300,
        warning: { threshold: 500, durationSeconds: 300 },
      }),
    ).toBe("Inbound traffic: warning ≥ 500 Mbit/s for 5 min, critical ≥ 800 Mbit/s for 5 min");
    expect(ruleCondition({ metric: "connections", threshold: 20000, durationSeconds: 120 })).toBe(
      "TCP connections ≥ 20,000 for 2 min",
    );
    expect(ruleCondition({ metric: "restarted", threshold: 10, durationSeconds: 0 })).toBe(
      "Server restarted (up less than 10 min)",
    );
    expect(ruleCondition({ metric: "certificates", threshold: 7, durationSeconds: 0 })).toBe(
      "Any managed certificate expires within 7 days",
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
