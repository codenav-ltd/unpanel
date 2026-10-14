// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { rolloutPlan, type RolloutNode } from "./agent-rollout.ts";

const node = (id: string, patch: Partial<RolloutNode> = {}): RolloutNode => ({
  id,
  status: "active",
  online: true,
  agentVersion: "0.1.0-alpha.39",
  canUpdateAgent: true,
  ...patch,
});

describe("agent rollout plan", () => {
  it("updates online agents that are behind, in list order", () => {
    const plan = rolloutPlan(
      [node("a"), node("b", { agentVersion: "0.1.0-alpha.41" }), node("c")],
      "0.1.0-alpha.41",
    );
    expect(plan.ready.map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("sets aside offline and manual agents, and ignores pending, disabled and unknown ones", () => {
    const plan = rolloutPlan(
      [
        node("offline", { online: false }),
        node("manual", { canUpdateAgent: false }),
        node("pending", { status: "pending" }),
        node("disabled", { status: "disabled" }),
        node("unknown", { agentVersion: null }),
        node("ahead", { agentVersion: "0.1.0-alpha.42" }),
      ],
      "0.1.0-alpha.41",
    );
    expect(plan.ready).toEqual([]);
    expect(plan.offline.map((item) => item.id)).toEqual(["offline"]);
    expect(plan.manual.map((item) => item.id)).toEqual(["manual"]);
  });
});
