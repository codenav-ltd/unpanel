// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { updateResultVersion, waitForPanelUpdate } from "./update-flow.ts";

function health(version: string): Response {
  return new Response(JSON.stringify({ ok: true, version }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("panel update flow", () => {
  it("finishes when the target version answers", async () => {
    const result = await waitForPanelUpdate("0.1.0-alpha.18", {
      fetchImpl: async () => health("0.1.0-alpha.18"),
      wait: async () => undefined,
      attempts: 1,
    });
    expect(result).toEqual({ kind: "updated", version: "0.1.0-alpha.18" });
  });

  it("recognizes the previous version after a confirmed outage", async () => {
    const answers: Array<Error | Response> = [
      new Error("offline"),
      new Error("offline"),
      health("0.1.0-alpha.17"),
    ];
    const result = await waitForPanelUpdate("0.1.0-alpha.18", {
      fetchImpl: async () => {
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answer ?? health("0.1.0-alpha.17");
      },
      wait: async () => undefined,
      attempts: 3,
    });
    expect(result).toEqual({ kind: "rolled-back", version: "0.1.0-alpha.17" });
  });

  it("times out without mistaking the still-running old panel for success", async () => {
    const result = await waitForPanelUpdate("0.1.0-alpha.18", {
      fetchImpl: async () => health("0.1.0-alpha.17"),
      wait: async () => undefined,
      attempts: 2,
    });
    expect(result).toEqual({ kind: "timeout", version: "0.1.0-alpha.17" });
  });

  it("only accepts a success parameter for the running build", () => {
    expect(updateResultVersion("?updated=0.1.0-alpha.18", "0.1.0-alpha.18")).toBe("0.1.0-alpha.18");
    expect(updateResultVersion("?updated=0.1.0-alpha.17", "0.1.0-alpha.18")).toBe("");
  });
});
