// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { createAudit } from "../audit/log.ts";
import { openDatabase } from "../db/open.ts";
import { createAlerts } from "./service.ts";
import { registerAlertApi } from "./api.ts";

it("protects every alert route, refuses cross-origin changes, and never returns saved credentials", async () => {
  const db = openDatabase(":memory:");
  const alerts = createAlerts({
    db,
    masterKey: randomBytes(32),
    nodes: () => [],
    live: () => [],
    sampledAt: () => 0,
    certificates: () => [],
    publicUrl: () => "https://panel.example.com",
  });
  const app = new Hono();
  registerAlertApi(app, {
    alerts,
    audit: createAudit(db),
    username: (c) => (c.req.header("cookie") === "fixture=owner" ? "owner" : null),
    publicUrl: () => "https://panel.example.com",
  });
  const headers = { cookie: "fixture=owner", "content-type": "application/json" };
  try {
    for (const [path, method] of [
      ["", "GET"],
      ["/rules", "POST"],
      ["/rules/id", "PUT"],
      ["/rules/id", "DELETE"],
      ["/incidents/id/acknowledge", "POST"],
      ["/incidents/id/silence", "POST"],
      ["/channels/email", "POST"],
      ["/channels/id/email", "PUT"],
      ["/channels/id", "PATCH"],
      ["/channels/id", "DELETE"],
      ["/channels/id/test", "POST"],
      ["/telegram/setup", "POST"],
      ["/telegram/id/poll", "POST"],
      ["/telegram/id/restart", "POST"],
      ["/telegram/id/confirm", "POST"],
      ["/telegram/id", "DELETE"],
    ] as const) {
      expect((await app.request(`/api/v1/alerts${path}`, { method })).status).toBe(401);
    }
    expect(
      (
        await app.request("/api/v1/alerts/channels/email", {
          method: "POST",
          headers: { ...headers, origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request("/api/v1/alerts/channels/email", { method: "POST", headers, body: "[]" }))
        .status,
    ).toBe(400);
    const response = await app.request("/api/v1/alerts/channels/email", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "API channel",
        provider: "resend",
        from: "alert@example.com",
        to: ["ops@example.com"],
        secret: "fixture-private-key",
        enabled: true,
        minimumSeverity: "warning",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("fixture-private-key");
  } finally {
    await alerts.close();
    db.close();
  }
});
