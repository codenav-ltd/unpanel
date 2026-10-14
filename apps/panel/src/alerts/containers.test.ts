// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { classify, createContainerWatch } from "./containers.ts";

const row = (State: string, Status: string, Id = "a".repeat(64)) => ({
  Id,
  Names: ["/web"],
  State,
  Status,
});

describe("classify", () => {
  it("reads running, unhealthy and restarting containers", () => {
    expect(classify(row("running", "Up 2 hours (healthy)"), true, false)).toEqual({
      name: "web",
      down: false,
      note: "is running",
    });
    expect(classify(row("running", "Up 3 minutes (unhealthy)"), true, false)).toMatchObject({
      down: true,
      note: "is running but failing its health check",
    });
    expect(
      classify(row("restarting", "Restarting (137) 4 seconds ago"), true, false),
    ).toMatchObject({ down: true, note: "keeps restarting (last exit code 137)" });
  });

  it("reports a crash but not a clean exit, a stop from Unpanel, or an old failure", () => {
    expect(classify(row("exited", "Exited (1) 2 minutes ago"), false, false)).toMatchObject({
      down: true,
      note: "stopped with exit code 1",
    });
    expect(classify(row("exited", "Exited (0) 2 minutes ago"), true, false)).toBeNull();
    expect(classify(row("exited", "Exited (143) 2 minutes ago"), true, true)).toBeNull();
    expect(classify(row("exited", "Exited (1) 3 weeks ago"), false, false)).toBeNull();
    expect(classify(row("exited", "Exited (1) 3 weeks ago"), true, false)).toMatchObject({
      down: true,
    });
    expect(classify(row("paused", "Up 2 hours (Paused)"), true, false)).toBeNull();
    expect(classify(row("created", "Created"), false, false)).toBeNull();
  });
});

describe("container watch", () => {
  it("polls each node at most every 30 seconds and goes stale after 90", async () => {
    let clock = 0;
    let rows = [row("running", "Up 1 hour")];
    const calls: string[] = [];
    const watch = createContainerWatch({
      now: () => clock,
      list: async (id) => {
        calls.push(id);
        return rows;
      },
    });
    expect(watch.read("n1")).toBeNull();
    watch.refresh(["n1"]);
    await new Promise((resolve) => setTimeout(resolve));
    watch.refresh(["n1"]);
    expect(calls).toEqual(["n1"]);
    expect(watch.read("n1")).toMatchObject({ fresh: true, containers: [{ down: false }] });
    // Stopped from Unpanel: the next poll comes early and does not count the exit.
    watch.stopped("n1", "a".repeat(64));
    rows = [row("exited", "Exited (143) 1 second ago")];
    watch.refresh(["n1"]);
    await new Promise((resolve) => setTimeout(resolve));
    expect(calls).toHaveLength(2);
    expect(watch.read("n1")?.containers).toEqual([]);
    clock = 91_000;
    expect(watch.read("n1")?.fresh).toBe(false);
  });
});
