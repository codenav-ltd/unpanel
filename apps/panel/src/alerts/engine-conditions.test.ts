// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/open.ts";
import { blankNodeLive } from "../hub.ts";
import { NOT_FILLING } from "../metrics/forecast.ts";
import type { NodeRecord } from "../nodes/store.ts";
import { createChannels } from "./channels.ts";
import type { ContainerHealth } from "./containers.ts";
import { createAlertEngine } from "./engine.ts";

function fixture() {
  const db = openDatabase(":memory:");
  let clock = 1_000_000;
  const live = { ...blankNodeLive("node"), online: true };
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
  channels.saveEmail({
    name: "Everything",
    provider: "resend",
    from: "alerts@example.com",
    to: ["owner@example.com"],
    secret: "test-credential",
    enabled: true,
    minimumSeverity: "warning",
  });
  const state = {
    forecast: null as number | null,
    containers: null as { fresh: boolean; containers: ContainerHealth[] } | null,
    refreshed: [] as string[][],
  };
  const engine = createAlertEngine({
    db,
    channels,
    now: () => clock,
    nodes: () => [node],
    live: () => [live],
    sampledAt: () => clock,
    certificates: () => [],
    publicUrl: () => "",
    diskForecast: () => state.forecast,
    containers: {
      read: () => state.containers,
      refresh: (ids) => state.refreshed.push([...ids]),
    },
  });
  for (const rule of engine.rules()) engine.remove(rule.id);
  const titles = () =>
    channels
      .logs()
      .map((log) => log.title)
      .reverse();
  return {
    live,
    state,
    engine,
    titles,
    at: (ms: number) => {
      clock += ms;
      engine.tick();
    },
  };
}

function rule(metric: string, threshold: number, warning: number | null, durations = [0, 0]) {
  return {
    name: metric,
    metric,
    threshold,
    durationSeconds: durations[1],
    severity: "critical",
    warning: warning === null ? null : { threshold: warning, durationSeconds: durations[0] },
    enabled: true,
    nodeIds: [],
    channelIds: [],
    recovery: true,
    repeatMinutes: 0,
  };
}

describe("inode rules", () => {
  it("fire on the share of inodes used", () => {
    const f = fixture();
    f.engine.save(rule("inodes", 90, 80));
    f.live.inodeRatio = 0.85;
    f.at(0);
    expect(f.engine.incidents()).toMatchObject([
      {
        severity: "warning",
        detail: "85.0% of the system disk's inodes are used (warning at 80%).",
      },
    ]);
  });

  it("stay quiet for agents that do not report inodes", () => {
    const f = fixture();
    f.engine.save(rule("inodes", 90, 80));
    f.at(0);
    expect(f.engine.incidents()).toHaveLength(0);
  });
});

describe("disk forecast rules", () => {
  it("warn days ahead, turn critical close to full, and clear once the disk stops filling", () => {
    const f = fixture();
    f.engine.save(rule("disk_forecast", 12, 72));
    f.state.forecast = 50;
    f.at(0);
    expect(f.engine.incidents()[0]?.detail).toBe(
      "At its recent rate the system disk fills in about 2 days (warning within 72 hours).",
    );
    f.state.forecast = 9.6;
    f.at(15_000);
    expect(f.engine.incidents()).toMatchObject([
      {
        severity: "critical",
        detail:
          "At its recent rate the system disk fills in about 10 hours (critical within 12 hours).",
      },
    ]);
    // Just past the warning line is not enough; the forecast must move well clear of it.
    f.state.forecast = 80;
    f.at(15_000);
    f.at(60_000);
    expect(f.engine.incidents()[0]?.resolvedAt).toBeNull();
    f.state.forecast = NOT_FILLING;
    f.at(15_000);
    f.at(60_000);
    expect(f.engine.incidents()[0]).toMatchObject({
      detail: "The system disk is no longer filling up.",
    });
    expect(f.engine.incidents()[0]?.resolvedAt).not.toBeNull();
    expect(f.titles()).toEqual([
      "Unpanel · Warning: disk_forecast",
      "Unpanel · Now critical: disk_forecast",
      "Unpanel · Resolved: disk_forecast",
    ]);
  });

  it("asks for more hours on the warning than on critical", () => {
    const f = fixture();
    expect(() => f.engine.save(rule("disk_forecast", 24, 12))).toThrow(/more hours/);
  });
});

describe("container rules", () => {
  const down = (note = "stopped with exit code 1"): ContainerHealth => ({
    name: "web",
    down: true,
    note,
  });

  it("polls only while a container rule is enabled", () => {
    const f = fixture();
    f.at(0);
    expect(f.state.refreshed).toEqual([]);
    f.engine.save(rule("container", 1, 1, [60, 300]));
    f.at(0);
    expect(f.state.refreshed).toEqual([["node"]]);
  });

  it("track each container, wait out stale readings, and report recovery", () => {
    const f = fixture();
    f.engine.save({ ...rule("container", 1, 1, [60, 300]), threshold: 999 });
    expect(f.engine.rules()[0]?.threshold).toBe(1);
    f.state.containers = { fresh: true, containers: [down()] };
    f.at(0);
    f.at(60_000);
    expect(f.engine.incidents()).toMatchObject([
      {
        targetId: "node:container:web",
        targetName: "web on Production",
        severity: "warning",
        detail: "Container web stopped with exit code 1.",
      },
    ]);
    // A failed poll is not a recovery, and does not end the incident.
    f.state.containers = { fresh: false, containers: [down()] };
    f.at(120_000);
    f.at(120_000);
    expect(f.engine.incidents()).toMatchObject([{ resolvedAt: null, severity: "warning" }]);
    f.state.containers = { fresh: true, containers: [down("keeps restarting")] };
    f.at(15_000);
    f.at(300_000);
    expect(f.engine.incidents()).toMatchObject([
      { severity: "critical", detail: "Container web keeps restarting." },
    ]);
    f.state.containers = {
      fresh: true,
      containers: [{ name: "web", down: false, note: "is running" }],
    };
    f.at(15_000);
    f.at(60_000);
    expect(f.engine.incidents()[0]).toMatchObject({ detail: "Container web is running." });
    expect(f.engine.incidents()[0]?.resolvedAt).not.toBeNull();
  });

  it("warn sooner than critical", () => {
    const f = fixture();
    expect(() => f.engine.save(rule("container", 1, 1, [300, 60]))).toThrow(/stopped container/);
  });
});
