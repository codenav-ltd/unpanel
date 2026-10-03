// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTurnstileToken, TurnstileUnavailableError } from "./turnstile.ts";

afterEach(() => vi.restoreAllMocks());
describe("Turnstile server verification", () => {
  it("checks the purpose and allowed hostname of a setup challenge", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({ success: true, action: "setup", hostname: "panel.example.com" }),
      );
    const input = {
      secret: "private",
      token: "response",
      ip: "203.0.113.1",
      action: "setup" as const,
      hostnames: ["panel.example.com"],
    };
    expect(await verifyTurnstileToken(input)).toBe(true);
    expect(await verifyTurnstileToken({ ...input, action: "login" })).toBe(false);
    expect(await verifyTurnstileToken({ ...input, hostnames: ["different.example.com"] })).toBe(
      false,
    );
    expect(fetcher.mock.calls[0]?.[1]?.body?.toString()).toBe(
      "secret=private&response=response&remoteip=203.0.113.1",
    );
  });
  it("keeps login purpose as the default and contains malformed/unavailable replies", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ success: true, action: "login" }));
    const input = { secret: "private", token: "response", ip: "" };
    expect(await verifyTurnstileToken(input)).toBe(true);
    fetcher.mockResolvedValue(Response.json(null));
    await expect(verifyTurnstileToken(input)).rejects.toBeInstanceOf(TurnstileUnavailableError);
    fetcher.mockRejectedValue(new Error("private URL and secret"));
    await expect(verifyTurnstileToken(input)).rejects.toThrow("Turnstile could not be reached.");
  });
});
