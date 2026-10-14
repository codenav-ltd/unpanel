// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { containerHealth, summarizeContainers, type ContainerRow } from "./docker-summary.ts";

const row = (name: string, State: string, Status: string): ContainerRow => ({
  Id: `${name}-id-0123456789`,
  Names: [`/${name}`],
  Image: "nginx:1.27",
  State,
  Status,
});

describe("docker summary", () => {
  it("treats restarts, unhealthy checks and non-zero exits as failing", () => {
    expect(containerHealth(row("a", "restarting", "Restarting (1) 3 seconds ago"))).toBe("failing");
    expect(containerHealth(row("a", "running", "Up 2 hours (unhealthy)"))).toBe("failing");
    expect(containerHealth(row("a", "exited", "Exited (137) 5 minutes ago"))).toBe("failing");
    expect(containerHealth(row("a", "exited", "Exited (0) 5 minutes ago"))).toBe("stopped");
    expect(containerHealth(row("a", "running", "Up 2 hours (healthy)"))).toBe("running");
    expect(containerHealth(row("a", "paused", "Up 2 hours (Paused)"))).toBe("other");
  });

  it("counts and lists failing containers first, then stopped, then running", () => {
    const summary = summarizeContainers(
      [
        row("web", "running", "Up 2 hours"),
        row("job", "exited", "Exited (0) 1 hour ago"),
        row("db", "running", "Up 2 hours (unhealthy)"),
        row("api", "running", "Up 1 hour"),
      ],
      3,
    );
    expect(summary).toMatchObject({ running: 3, stopped: 1, failing: 1, total: 4 });
    expect(summary.rows.map((item) => item.name)).toEqual(["db", "job", "api"]);
  });

  it("falls back to the short id when a container has no name", () => {
    const summary = summarizeContainers([{ ...row("x", "running", "Up"), Names: [] }]);
    expect(summary.rows[0]?.name).toBe("x-id-0123456");
  });
});
