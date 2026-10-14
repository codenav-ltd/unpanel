// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/open.ts";
import { blankNodeLive } from "../hub.ts";
import type { NodeRecord } from "../nodes/store.ts";
import { createChannels } from "./channels.ts";
import { createAlertEngine, RECOMMENDED_RULES } from "./engine.ts";

function fixture(
  options: {
    clear?: boolean;
    certificates?: { id: string; host: string; notAfter: number; active: boolean }[];
  } = {},
) {
  const db = openDatabase(":memory:");
  let clock = 1_000_000;
  const live = { ...blankNodeLive("node"), online: true, memRatio: 0.5 };
  const node: NodeRecord = {
    id: "node",
    name: "Production",
    status: "active",
    maintenance: false,
    tags: [],
    transport: "wss",
    hasKey: true,
  };
  const channels = createChannels({
    db,
    masterKey: randomBytes(32),
    now: () => clock,
    send: vi.fn(async () => undefined),
  });
  for (const [name, minimumSeverity] of [
    ["Everything", "warning"],
    ["Pager", "critical"],
  ] as const)
    channels.saveEmail({
      name,
      provider: "resend",
      from: "alerts@example.com",
      to: ["owner@example.com"],
      secret: "test-credential",
      enabled: true,
      minimumSeverity,
    });
  const engine = createAlertEngine({
    db,
    channels,
    now: () => clock,
    nodes: () => [node],
    live: () => [live],
    sampledAt: () => clock,
    certificates: () => options.certificates ?? [],
    publicUrl: () => "",
  });
  if (options.clear !== false) for (const rule of engine.rules()) engine.remove(rule.id);
  const sent = (channel: string) =>
    channels
      .logs()
      .filter((log) => log.channelName === channel)
      .map((log) => log.title)
      .reverse();
  return {
    db,
    live,
    engine,
    sent,
    advance: (ms: number) => {
      clock += ms;
    },
    at: (ms: number) => {
      clock += ms;
      engine.tick();
    },
  };
}

const memoryRule = {
  name: "Memory usage",
  metric: "memory",
  threshold: 90,
  durationSeconds: 60,
  severity: "critical",
  warning: { threshold: 80, durationSeconds: 120 },
  enabled: true,
  nodeIds: [],
  channelIds: [],
  recovery: true,
  repeatMinutes: 30,
};

describe("two-level rules", () => {
  it("opens one incident as a warning and raises it to critical in place", () => {
    const f = fixture();
    try {
      f.engine.save(memoryRule);
      f.live.memRatio = 0.85;
      f.at(0);
      f.at(119_000);
      expect(f.engine.incidents()).toHaveLength(0);
      f.at(1_000);
      expect(f.engine.incidents()).toMatchObject([{ severity: "warning", resolvedAt: null }]);
      expect(f.sent("Everything")).toEqual(["Unpanel · Warning: Memory usage"]);
      expect(f.sent("Pager")).toEqual([]);

      f.live.memRatio = 0.95;
      f.at(30_000);
      f.at(60_000);
      const incidents = f.engine.incidents();
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({ severity: "critical", resolvedAt: null });
      expect(incidents[0]?.detail).toContain("critical at 90%");
      expect(f.sent("Everything")).toEqual([
        "Unpanel · Warning: Memory usage",
        "Unpanel · Now critical: Memory usage",
      ]);
      expect(f.sent("Pager")).toEqual(["Unpanel · Now critical: Memory usage"]);
    } finally {
      f.db.close();
    }
  });

  it("steps back to warning quietly, then recovers below the warning level", () => {
    const f = fixture();
    try {
      f.engine.save(memoryRule);
      f.live.memRatio = 0.95;
      f.at(0);
      f.at(60_000);
      expect(f.engine.incidents()[0]?.severity).toBe("critical");
      const before = f.sent("Everything").length;

      f.live.memRatio = 0.85;
      f.at(1_000);
      f.at(59_000);
      expect(f.engine.incidents()[0]?.severity).toBe("critical");
      f.at(1_000);
      expect(f.engine.incidents()[0]).toMatchObject({ severity: "warning", resolvedAt: null });
      expect(f.sent("Everything")).toHaveLength(before);

      // Recovery is measured against the warning level, with the usual 5% margin.
      f.live.memRatio = 0.77;
      f.at(1_000);
      f.at(60_000);
      expect(f.engine.incidents()[0]?.resolvedAt).toBeNull();
      f.live.memRatio = 0.7;
      f.at(1_000);
      f.at(60_000);
      expect(f.engine.incidents()[0]?.resolvedAt).not.toBeNull();
    } finally {
      f.db.close();
    }
  });

  it("repeats reminders only while the incident is critical", () => {
    const f = fixture();
    try {
      f.engine.save(memoryRule);
      f.live.memRatio = 0.85;
      f.at(0);
      f.at(120_000);
      f.at(31 * 60_000);
      expect(f.sent("Everything")).toEqual(["Unpanel · Warning: Memory usage"]);
      f.live.memRatio = 0.95;
      f.at(1_000);
      f.at(60_000);
      f.at(31 * 60_000);
      expect(f.sent("Everything").slice(1)).toEqual([
        "Unpanel · Now critical: Memory usage",
        "Unpanel · Critical: Memory usage",
      ]);
    } finally {
      f.db.close();
    }
  });

  it("separates offline levels by how long the node has been gone", () => {
    const f = fixture();
    try {
      f.engine.save({
        ...memoryRule,
        name: "Node offline",
        metric: "offline",
        threshold: 1,
        durationSeconds: 300,
        warning: { threshold: 1, durationSeconds: 60 },
      });
      f.at(180_000);
      f.live.online = false;
      f.at(0);
      f.at(60_000);
      expect(f.engine.incidents()).toMatchObject([{ severity: "warning" }]);
      f.at(240_000);
      expect(f.engine.incidents()).toMatchObject([{ severity: "critical" }]);
    } finally {
      f.db.close();
    }
  });

  it("refuses warning levels that would not come first", () => {
    const f = fixture();
    try {
      expect(() =>
        f.engine.save({ ...memoryRule, warning: { threshold: 95, durationSeconds: 60 } }),
      ).toThrow("below the critical threshold");
      expect(() => f.engine.save({ ...memoryRule, severity: "warning" })).toThrow(
        "needs a critical rule",
      );
      expect(() =>
        f.engine.save({
          ...memoryRule,
          metric: "offline",
          durationSeconds: 60,
          warning: { threshold: 1, durationSeconds: 120 },
        }),
      ).toThrow("sooner than the critical alert");
      expect(() =>
        f.engine.save({
          ...memoryRule,
          metric: "certificate",
          threshold: 7,
          warning: { threshold: 3, durationSeconds: 0 },
        }),
      ).toThrow("more days remaining");
      f.engine.save({ ...memoryRule, warning: null });
      expect(f.engine.rules()[0]?.warning).toBeNull();
    } finally {
      f.db.close();
    }
  });
});

describe("recommended rules", () => {
  it("seeds a fresh install with the two-level set", () => {
    const f = fixture({ clear: false });
    try {
      expect(f.engine.rules().map((rule) => rule.name)).toEqual(
        RECOMMENDED_RULES.map(([name]) => name),
      );
      expect(f.engine.rules().every((rule) => rule.warning !== null)).toBe(true);
      expect(f.engine.legacyDefaults()).toBe(0);
    } finally {
      f.db.close();
    }
  });

  it("replaces untouched old defaults and keeps rules the user edited", () => {
    const f = fixture();
    try {
      const old = (
        name: string,
        metric: string,
        threshold: number,
        duration: number,
        severity: string,
      ) => ({
        name,
        metric,
        threshold,
        durationSeconds: duration,
        severity,
        enabled: true,
        nodeIds: [],
        channelIds: [],
        recovery: true,
        repeatMinutes: severity === "critical" ? 60 : 0,
      });
      f.engine.save(old("Node offline", "offline", 1, 120, "critical"));
      f.engine.save(old("Memory pressure", "memory", 95, 300, "warning"));
      f.engine.save({ ...old("Sustained CPU load", "cpu", 85, 600, "warning") });
      // Stored before alpha.41: no warning key at all.
      const stored = f.db.prepare("SELECT config FROM alert_rules").all() as { config: string }[];
      expect(
        stored.every(
          (row) =>
            !("warning" in JSON.parse(row.config)) || JSON.parse(row.config).warning === null,
        ),
      ).toBe(true);
      expect(f.engine.legacyDefaults()).toBe(2);

      f.engine.adoptRecommended();
      const names = f.engine.rules().map((rule) => rule.name);
      expect(names).toContain("Sustained CPU load");
      expect(names).not.toContain("Memory pressure");
      expect(names).toEqual(expect.arrayContaining(RECOMMENDED_RULES.map(([name]) => name)));
      expect(names.filter((name) => name === "Node offline")).toHaveLength(1);
      expect(f.engine.legacyDefaults()).toBe(0);
    } finally {
      f.db.close();
    }
  });
});

describe("more conditions", () => {
  function rule(metric: string, threshold: number, extra: Record<string, unknown> = {}) {
    return {
      name: metric,
      metric,
      threshold,
      durationSeconds: 0,
      severity: "warning",
      warning: null,
      enabled: true,
      nodeIds: [],
      channelIds: [],
      recovery: false,
      repeatMinutes: 0,
      ...extra,
    };
  }

  it("reads load per core, traffic in Mbit/s and TCP connections", () => {
    const f = fixture();
    try {
      Object.assign(f.live, {
        threads: 4,
        load5: 6,
        rxBps: 25_000_000,
        txBps: 100_000,
        tcpCount: 12_000,
      });
      f.engine.save(rule("load", 140));
      f.engine.save(rule("network_in", 150));
      f.engine.save(rule("network_out", 150));
      f.engine.save(rule("connections", 10_000));
      f.at(0);
      const open = f.engine
        .incidents()
        .map((incident) => incident.name)
        .sort();
      expect(open).toEqual(["connections", "load", "network_in"]);
      expect(f.engine.incidents().find((i) => i.name === "network_in")?.detail).toBe(
        "Inbound traffic is 200.0 Mbit/s (warning at 150 Mbit/s).",
      );
      expect(f.engine.incidents().find((i) => i.name === "load")?.detail).toContain("150%");
    } finally {
      f.db.close();
    }
  });

  it("notices a restart from uptime and clears once the server has been up a while", () => {
    const f = fixture();
    try {
      f.live.uptime = 120;
      f.engine.save(rule("restarted", 10));
      f.at(0);
      expect(f.engine.incidents()).toMatchObject([{ detail: "The server started 2 minutes ago." }]);
      f.live.uptime = 11 * 60;
      f.at(1_000);
      f.at(60_000);
      expect(f.engine.incidents()[0]?.resolvedAt).not.toBeNull();
    } finally {
      f.db.close();
    }
  });

  it("refuses thresholds outside a condition's range", () => {
    const f = fixture();
    try {
      expect(() => f.engine.save(rule("cpu", 150))).toThrow();
      expect(() => f.engine.save(rule("bogus", 10))).toThrow("supported alert condition");
      f.engine.save(rule("load", 300));
      expect(f.engine.rules()[0]?.threshold).toBe(300);
    } finally {
      f.db.close();
    }
  });
});

it("watches every managed certificate on its own", () => {
  const day = 86_400_000;
  const f = fixture({
    certificates: [
      { id: "a", host: "panel.example.com", notAfter: 1_000_000 + 30 * day, active: true },
      { id: "b", host: "api.example.com", notAfter: 1_000_000 + 5 * day, active: false },
    ],
  });
  try {
    f.engine.save({
      name: "Certificates",
      metric: "certificates",
      threshold: 7,
      durationSeconds: 0,
      severity: "critical",
      warning: { threshold: 21, durationSeconds: 0 },
      enabled: true,
      nodeIds: ["node"],
      channelIds: [],
      recovery: true,
      repeatMinutes: 0,
    });
    expect(f.engine.rules()[0]?.nodeIds).toEqual([]);
    f.at(0);
    expect(f.engine.incidents()).toMatchObject([
      { targetName: "api.example.com", severity: "critical" },
    ]);
  } finally {
    f.db.close();
  }
});
