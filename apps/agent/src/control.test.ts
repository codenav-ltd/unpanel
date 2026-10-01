// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it, vi } from "vitest";
import { ControlUnsupported, controlPanel, panelUnit, serviceCommand } from "./control.ts";

describe("serviceCommand", () => {
  it("drives systemd on Linux", () => {
    expect(serviceCommand("restart", "linux")).toEqual({
      file: "systemctl",
      args: ["restart", panelUnit],
    });
    expect(serviceCommand("stop", "linux")).toEqual({
      file: "systemctl",
      args: ["stop", panelUnit],
    });
  });

  it("refuses rather than guessing on a host without systemd", () => {
    expect(() => serviceCommand("stop", "win32")).toThrow(ControlUnsupported);
    expect(() => serviceCommand("stop", "darwin")).toThrow(/systemd/);
  });
});

describe("controlPanel", () => {
  it("answers before it acts, so the reply is not lost with the service", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    try {
      const result = controlPanel("restart", { run, delayMs: 250, platform: "linux" });

      expect(result).toEqual({ unit: panelUnit, action: "restart", delayMs: 250 });
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(250);
      expect(run).toHaveBeenCalledWith("systemctl", ["restart", panelUnit]);
    } finally {
      vi.useRealTimers();
    }
  });
});
