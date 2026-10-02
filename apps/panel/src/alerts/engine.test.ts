// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { openDatabase } from "../db/open.ts";
import { blankNodeLive } from "../hub.ts";
import type { NodeRecord } from "../nodes/store.ts";
import { createChannels } from "./channels.ts";
import { createAlertEngine } from "./engine.ts";

function fixture() {
  const db = openDatabase(":memory:");
  let clock = 1_000_000;
  let fresh = true;
  const live = { ...blankNodeLive("node"), online: true, cpuRatio: 0.99 };
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
    name: "Operations",
    provider: "resend",
    from: "alerts@example.com",
    to: ["owner@example.com"],
    secret: "test-credential",
    enabled: true,
    minimumSeverity: "warning",
  });
  const options = {
    db,
    channels,
    now: () => clock,
    nodes: () => [node],
    live: () => [live],
    sampledAt: () => (fresh ? clock : clock - 60_000),
    certificates: () => [],
    publicUrl: () => "https://panel.example.com",
  };
  let engine = createAlertEngine(options);
  for (const rule of engine.rules()) engine.remove(rule.id);
  const rule = {
    name: "High CPU",
    metric: "cpu",
    threshold: 95,
    durationSeconds: 60,
    severity: "critical",
    enabled: true,
    nodeIds: [],
    channelIds: [],
    recovery: true,
    repeatMinutes: 5,
  };
  engine.save(rule);
  return {
    db,
    live,
    node,
    channels,
    rule,
    get engine() {
      return engine;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    stale: () => {
      fresh = false;
    },
    fresh: () => {
      fresh = true;
    },
    restart: () => {
      engine = createAlertEngine(options);
    },
  };
}
it("waits for a sustained breach, persists an incident across restart, and requires stable recovery", () => {
  const f = fixture();
  try {
    f.engine.tick();
    f.advance(59_000);
    f.engine.tick();
    expect(f.engine.incidents()).toHaveLength(0);
    f.advance(1000);
    f.engine.tick();
    expect(f.engine.incidents()).toHaveLength(1);
    expect(f.channels.logs()).toHaveLength(1);
    const id = first(f.engine.incidents()).id;
    f.restart();
    f.engine.tick();
    expect(first(f.engine.incidents()).id).toBe(id);
    expect(f.channels.logs()).toHaveLength(1);
    f.live.cpuRatio = 0.92;
    f.advance(60_000);
    f.engine.tick();
    expect(first(f.engine.incidents()).resolvedAt).toBeNull();
    f.live.cpuRatio = 0.8;
    f.engine.tick();
    f.advance(59_000);
    f.engine.tick();
    expect(first(f.engine.incidents()).resolvedAt).toBeNull();
    f.advance(1000);
    f.engine.tick();
    expect(first(f.engine.incidents()).resolvedAt).not.toBeNull();
    expect(f.channels.logs()).toHaveLength(2);
  } finally {
    f.db.close();
  }
});
it("does not interpret missing, stale or disconnected metrics as recovery", () => {
  const f = fixture();
  try {
    f.engine.tick();
    f.advance(60_000);
    f.engine.tick();
    f.live.online = false;
    f.live.cpuRatio = 0;
    f.advance(120_000);
    f.engine.tick();
    expect(first(f.engine.incidents()).resolvedAt).toBeNull();
    f.live.online = true;
    f.stale();
    f.engine.tick();
    f.advance(120_000);
    f.engine.tick();
    expect(first(f.engine.incidents()).resolvedAt).toBeNull();
    f.fresh();
    f.engine.tick();
    f.advance(60_000);
    f.engine.tick();
    expect(first(f.engine.incidents()).resolvedAt).not.toBeNull();
  } finally {
    f.db.close();
  }
});
it("honors maintenance, incident silence and acknowledgement without dropping incident history", () => {
  const f = fixture();
  try {
    f.node.maintenance = true;
    f.engine.tick();
    f.advance(60_000);
    f.engine.tick();
    expect(f.engine.incidents()).toHaveLength(1);
    expect(f.channels.logs()).toHaveLength(0);
    f.node.maintenance = false;
    f.engine.tick();
    expect(f.channels.logs()).toHaveLength(1);
    const id = first(f.engine.incidents()).id;
    f.engine.silence(id, 3600);
    f.advance(300_000);
    f.engine.tick();
    expect(f.channels.logs()).toHaveLength(1);
    f.advance(3_600_000);
    f.engine.tick();
    expect(f.channels.logs()).toHaveLength(2);
    f.engine.acknowledge(id);
    f.advance(300_000);
    f.engine.tick();
    expect(f.channels.logs()).toHaveLength(2);
    f.node.status = "disabled";
    f.engine.tick();
    expect(first(f.engine.incidents()).resolvedAt).not.toBeNull();
    expect(f.channels.logs()).toHaveLength(2);
  } finally {
    f.db.close();
  }
});
it("applies offline startup grace and ignores pending nodes", () => {
  const f = fixture();
  try {
    for (const rule of f.engine.rules()) f.engine.remove(rule.id);
    f.engine.save({ ...f.rule, metric: "offline", durationSeconds: 120 });
    f.live.online = false;
    f.engine.tick();
    f.advance(179_000);
    f.engine.tick();
    expect(f.engine.incidents()).toHaveLength(0);
    f.advance(1000);
    f.engine.tick();
    f.advance(120_000);
    f.engine.tick();
    expect(f.engine.incidents()).toHaveLength(1);
    f.node.status = "pending";
    f.engine.tick();
    expect(first(f.engine.incidents()).resolvedAt).not.toBeNull();
  } finally {
    f.db.close();
  }
});

it("cancels queued incident notifications when their rule is changed or removed", async () => {
  const f = fixture();
  try {
    f.engine.tick();
    f.advance(60_000);
    f.engine.tick();
    const id = first(f.engine.rules()).id;
    f.engine.save({ ...f.rule, threshold: 100 }, id);
    await f.channels.flush();
    expect(first(f.channels.logs()).state).toBe("cancelled");
    expect(first(f.engine.incidents()).resolvedAt).not.toBeNull();
    f.engine.save({ ...f.rule, durationSeconds: 0 }, id);
    f.engine.tick();
    f.engine.remove(id);
    await f.channels.flush();
    expect(f.channels.logs().every((log) => log.state === "cancelled")).toBe(true);
  } finally {
    f.db.close();
  }
});

it("delivers a current incident after its first eligible channel is enabled", async () => {
  const f = fixture();
  try {
    const id = first(f.channels.view()).id;
    f.channels.enable(id, false);
    f.engine.save({ ...f.rule, durationSeconds: 0, repeatMinutes: 0 }, first(f.engine.rules()).id);
    f.engine.tick();
    expect(f.channels.logs()).toHaveLength(0);
    f.channels.enable(id, true);
    f.advance(15_000);
    f.engine.tick();
    await f.channels.flush();
    expect(first(f.channels.logs())).toMatchObject({
      state: "sent",
      title: "Unpanel · Critical: High CPU",
    });
    f.live.cpuRatio = 0.1;
    f.engine.tick();
    f.advance(60_000);
    f.engine.tick();
    await f.channels.flush();
    expect(first(f.channels.logs())).toMatchObject({
      state: "sent",
      title: "Unpanel · Resolved: High CPU",
    });
  } finally {
    f.db.close();
  }
});

it("does not send an obsolete firing notification or a recovery alone when an unsent incident recovers", async () => {
  const f = fixture();
  try {
    f.engine.tick();
    f.advance(60_000);
    f.engine.tick();
    f.live.cpuRatio = 0.1;
    f.engine.tick();
    f.advance(60_000);
    f.engine.tick();
    await f.channels.flush();
    expect(f.channels.logs()).toHaveLength(2);
    expect(f.channels.logs().every((log) => log.state === "cancelled")).toBe(true);
  } finally {
    f.db.close();
  }
});

it("cancels pending reminders on acknowledgement and pending notifications on silence", async () => {
  const f = fixture();
  try {
    f.engine.tick();
    f.advance(60_000);
    f.engine.tick();
    await f.channels.flush();
    const id = first(f.engine.incidents()).id;
    f.advance(300_000);
    f.engine.tick();
    f.engine.acknowledge(id);
    await f.channels.flush();
    expect(first(f.channels.logs()).state).toBe("cancelled");
    f.engine.save({ ...f.rule, durationSeconds: 0 }, first(f.engine.rules()).id);
    f.engine.tick();
    f.engine.silence(first(f.engine.incidents()).id, 3600);
    await f.channels.flush();
    expect(first(f.channels.logs()).state).toBe("cancelled");
  } finally {
    f.db.close();
  }
});

it("can notify after silence ends when the initial notification was cancelled before delivery", async () => {
  const f = fixture();
  try {
    f.engine.save({ ...f.rule, durationSeconds: 0, repeatMinutes: 0 }, first(f.engine.rules()).id);
    f.engine.tick();
    const id = first(f.engine.incidents()).id;
    f.engine.silence(id, 3600);
    f.advance(3_600_000);
    f.engine.tick();
    await f.channels.flush();
    expect(first(f.channels.logs()).state).toBe("sent");
    const row = f.db
      .prepare("SELECT message FROM notification_deliveries WHERE state = 'sent'")
      .get() as { message: string };
    expect(JSON.parse(row.message).source.event).toBe("firing");
  } finally {
    f.db.close();
  }
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
function first<T>(items: T[]): T {
  return required(items[0]);
}
