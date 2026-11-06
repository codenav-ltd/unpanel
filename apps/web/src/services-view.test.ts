// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import type { ServiceSummary, ServiceTimer } from "./services-client.ts";
import {
  countUnits,
  formatCpuTime,
  formatRelative,
  guardOf,
  isAddressable,
  primaryChoice,
  secondaryChoices,
  sortTimers,
  stateText,
  stateTone,
  unitFileLines,
  visibleUnits,
} from "./services-view.ts";

const unit = (name: string, patch: Partial<ServiceSummary> = {}): ServiceSummary => ({
  name,
  description: `${name} description`,
  loadState: "loaded",
  activeState: "active",
  subState: "running",
  unitFileState: "enabled",
  ...patch,
});

const failed = unit("backup.service", { activeState: "failed", subState: "failed" });
const idle = unit("apt-daily.service", {
  activeState: "inactive",
  subState: "dead",
  unitFileState: "static",
});
const masked = unit("plymouth.service", {
  loadState: "masked",
  activeState: "inactive",
  subState: "dead",
  unitFileState: "masked",
});

describe("state presentation", () => {
  it("names the sub-state while active and the state otherwise", () => {
    expect(stateText(unit("a.service"))).toBe("running");
    expect(stateText(unit("a.service", { subState: "exited" }))).toBe("exited");
    expect(stateText(failed)).toBe("failed");
    expect(stateText(idle)).toBe("inactive");
    expect(stateText(unit("a.service", { activeState: "activating", subState: "start" }))).toBe(
      "activating (start)",
    );
    expect(stateText(masked)).toBe("masked");
  });

  it("picks a tone that reads without colour alone", () => {
    expect(stateTone(unit("a.service"))).toBe("ok");
    expect(stateTone(unit("a.service", { subState: "exited" }))).toBe("idle");
    expect(stateTone(failed)).toBe("danger");
    expect(stateTone(idle)).toBe("off");
    expect(stateTone(unit("a.service", { activeState: "deactivating", subState: "stop" }))).toBe(
      "warn",
    );
  });
});

describe("filtering and order", () => {
  const all = [idle, unit("nginx.service"), failed, masked, unit("cron.service")];

  it("counts what each filter would show", () => {
    expect(countUnits(all)).toEqual({ all: 5, running: 2, failed: 1, enabled: 3 });
  });

  it("lists failed units first, then active ones, then the rest by name", () => {
    expect(visibleUnits(all, "all", "").map((row) => row.name)).toEqual([
      "backup.service",
      "cron.service",
      "nginx.service",
      "apt-daily.service",
      "plymouth.service",
    ]);
  });

  it("applies the filter and the search together, matching names and descriptions", () => {
    expect(visibleUnits(all, "failed", "").map((row) => row.name)).toEqual(["backup.service"]);
    expect(visibleUnits(all, "running", "NGI").map((row) => row.name)).toEqual(["nginx.service"]);
    expect(visibleUnits(all, "all", "cron service")).toEqual([]);
    expect(visibleUnits(all, "all", "cron.service description")).toHaveLength(1);
  });
});

describe("what can be changed", () => {
  it("offers restart on a running unit and start on a stopped one", () => {
    expect(primaryChoice(unit("a.service"))?.id).toBe("restart");
    expect(primaryChoice(failed)?.id).toBe("start");
    expect(primaryChoice(masked)).toBeNull();
  });

  it("offers stop and reload only while active", () => {
    expect(secondaryChoices(unit("a.service")).map((row) => row.id)).toEqual([
      "stop",
      "reload",
      "disable",
      "disable-now",
    ]);
    expect(secondaryChoices(idle).map((row) => row.id)).toEqual(["restart"]);
    expect(
      secondaryChoices(
        unit("a.service", { activeState: "inactive", unitFileState: "disabled" }),
      ).map((row) => row.id),
    ).toEqual(["restart", "enable", "enable-now"]);
    expect(secondaryChoices(masked)).toEqual([]);
  });

  it("offers nothing for names the protocol refuses", () => {
    const escaped = unit("systemd-fsck@dev-disk-by\\x2dlabel-root.service");
    expect(isAddressable(escaped.name)).toBe(false);
    expect(isAddressable("nginx.service")).toBe(true);
    expect(primaryChoice(escaped)).toBeNull();
    expect(secondaryChoices(escaped)).toEqual([]);
  });

  it("asks the protocol how careful to be", () => {
    expect(guardOf("sshd.service", { kind: "action", action: "stop" })).toBe("confirm");
    expect(guardOf("sshd.service", { kind: "action", action: "restart" })).toBe("free");
    expect(guardOf("docker.service", { kind: "disable", now: true })).toBe("confirm");
    expect(guardOf("unpanel-agent.service", { kind: "enable", now: false })).toBe("refused");
  });
});

describe("timers", () => {
  const timer = (unit: string, next: number | null): ServiceTimer => ({
    unit,
    activates: unit.replace(".timer", ".service"),
    next,
    last: null,
  });

  it("orders by next run with never-scheduled timers last", () => {
    const rows = sortTimers(
      [timer("b.timer", null), timer("c.timer", 300), timer("a.timer", 100)],
      "",
    );
    expect(rows.map((row) => row.unit)).toEqual(["a.timer", "c.timer", "b.timer"]);
    expect(sortTimers(rows, "c.serv").map((row) => row.unit)).toEqual(["c.timer"]);
  });
});

describe("formatting", () => {
  it("reads times relative to now", () => {
    const now = Date.UTC(2026, 10, 6, 12);
    expect(formatRelative(now + 3 * 3_600_000, now)).toBe("in 3 hours");
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(formatRelative(now, now)).toBe("now");
  });

  it("scales CPU time", () => {
    expect(formatCpuTime(12_000_000)).toBe("12 ms");
    expect(formatCpuTime(2_500_000_000)).toBe("2.5 s");
    expect(formatCpuTime(184e9)).toBe("3 min 04 s");
    expect(formatCpuTime(7_380e9)).toBe("2 h 03 min");
  });
});

describe("unit file", () => {
  it("sorts lines into the kinds the viewer styles", () => {
    const lines = unitFileLines(
      "# /lib/systemd/system/x.service\n[Unit]\nDescription=X\n; note\nExecStart=/bin/x --a=b\n  continued",
    );
    expect(lines.map((line) => line.kind)).toEqual([
      "path",
      "section",
      "key",
      "comment",
      "key",
      "plain",
    ]);
    expect(lines[4]).toEqual({ kind: "key", key: "ExecStart=", value: "/bin/x --a=b" });
  });
});
