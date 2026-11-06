// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { serviceGuard, serviceMethods, serviceOperations, serviceUnitName } from "./service.ts";

describe("service unit names", () => {
  it("accepts real unit names", () => {
    for (const name of ["nginx.service", "getty@tty1.service", "home.mount", "apt-daily.timer"])
      expect(serviceUnitName.safeParse(name).success).toBe(true);
  });

  it("rejects anything systemctl could read as an option or a path", () => {
    for (const name of [
      "nginx",
      "a b.service",
      "../x.service",
      "x.service;ls",
      "x.slice",
      "--now.service",
      "-x.service",
    ])
      expect(serviceUnitName.safeParse(name).success).toBe(false);
  });
});

describe("service guard", () => {
  it("asks for the unit name before stopping or disabling a protected unit", () => {
    for (const unit of [
      "sshd.service",
      "ssh.service",
      "systemd-resolved.service",
      "dbus.service",
      "docker.service",
      "unpanel.service",
    ]) {
      expect(serviceGuard(unit, "stop")).toBe("confirm");
      expect(serviceGuard(unit, "disable")).toBe("confirm");
      expect(serviceGuard(unit, "restart")).toBe("free");
      expect(serviceGuard(unit, "start")).toBe("free");
    }
  });

  it("leaves ordinary units free", () => {
    expect(serviceGuard("nginx.service", "stop")).toBe("free");
    expect(serviceGuard("redis-server.service", "disable")).toBe("free");
  });

  it("refuses every change to the agent's own unit", () => {
    for (const change of [
      "start",
      "stop",
      "restart",
      "reload",
      "try-restart",
      "enable",
      "disable",
    ] as const)
      expect(serviceGuard("unpanel-agent.service", change)).toBe("refused");
  });
});

describe("service methods", () => {
  it("declares one method per operation with the right risk", () => {
    for (const operation of serviceOperations) {
      const method = serviceMethods[operation];
      expect(method.name).toBe(`service.${operation}`);
      expect(method.capability).toBe("systemd");
    }
    expect(serviceMethods.list.risk).toBe("read");
    expect(serviceMethods.logs.risk).toBe("read");
    expect(serviceMethods.action.risk).toBe("write");
    expect(serviceMethods.daemonReload.permission).toBe("service:write");
  });

  it("bounds log reads", () => {
    const params = serviceMethods.logs.params;
    expect(params.safeParse({ units: ["nginx.service"] }).data?.lines).toBe(200);
    expect(params.safeParse({ units: [] }).success).toBe(false);
    expect(params.safeParse({ units: ["nginx.service"], lines: 5000 }).success).toBe(false);
    expect(params.safeParse({ units: ["nginx.service"], priority: 9 }).success).toBe(false);
  });
});
