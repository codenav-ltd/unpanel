// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { couldNotReach, readProblem, replyNotReceived } from "./http-error.ts";

describe("HTTP error copy", () => {
  it("does not claim a failed read changed anything", () => {
    const message = couldNotReach("load system history");
    expect(message).toContain("Check that the panel is running");
    expect(message).not.toContain("Nothing was changed");
  });

  it("warns that a write can succeed without its reply", () => {
    const message = replyNotReceived("save these settings", "Reload Settings before retrying.");
    expect(message).toContain("may already have been applied");
    expect(message).toContain("Reload Settings before retrying");
  });

  it("uses the API sentence when one is available", async () => {
    const response = new Response(
      JSON.stringify({ error: { message: "The node is offline. Start its agent and try again." } }),
      { status: 503 },
    );
    await expect(readProblem(response, "restart the panel")).resolves.toBe(
      "The node is offline. Start its agent and try again.",
    );
  });

  it("does not invent a no-change result for an unreadable response", async () => {
    const response = new Response("upstream failed", { status: 502 });
    const message = await readProblem(response, "install the update");
    expect(message).toContain("HTTP 502");
    expect(message).toContain("Open Logs");
    expect(message).not.toContain("Nothing was changed");
  });
});
