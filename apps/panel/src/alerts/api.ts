// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { Context, Hono } from "hono";
import type { Audit } from "../audit/log.ts";
import type { Alerts } from "./service.ts";
import { AlertError } from "./validation.ts";
import { DeliveryError } from "./providers.ts";

export function registerAlertApi(
  app: Hono,
  options: {
    alerts: Alerts;
    username: (c: Context) => string | null;
    publicUrl: () => string;
    audit: Audit;
  },
): void {
  const { alerts } = options;
  async function run(
    c: Context,
    action: string,
    work: (body: Record<string, unknown>, user: string) => unknown = () => undefined,
  ): Promise<Response> {
    const user = options.username(c);
    if (!user)
      return c.json(
        { error: { code: "E_UNAUTHENTICATED", message: "Sign in to manage alerts." } },
        401,
      );
    const origin = c.req.header("origin");
    if (
      c.req.method !== "GET" &&
      origin &&
      origin !== new URL(c.req.url).origin &&
      origin !== options.publicUrl()
    )
      return c.json(
        {
          error: {
            code: "E_FORBIDDEN",
            message: "Open this panel directly before changing alerts.",
          },
        },
        403,
      );
    try {
      let body: Record<string, unknown> = {};
      if (!["GET", "DELETE"].includes(c.req.method)) {
        try {
          const parsed: unknown = await c.req.json();
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          body = parsed as Record<string, unknown>;
        } catch {
          throw new AlertError("Send alert settings as a JSON object.");
        }
      }
      const data = await work(body, user);
      if (c.req.method !== "GET" && action !== "alert.telegram.poll")
        options.audit.record({ action, result: "ok", actorKind: "user", actorId: user });
      return c.json({ data: data ?? alerts.view() });
    } catch (error) {
      const message =
        error instanceof AlertError || error instanceof DeliveryError
          ? error.message
          : "The alert operation could not be completed. Reload Alerts to check its current state before retrying.";
      options.audit.record({
        action,
        result: "error",
        actorKind: "user",
        actorId: user,
        params: { detail: message },
      });
      const status =
        error instanceof AlertError && error.status === 404
          ? 404
          : error instanceof AlertError && error.status === 409
            ? 409
            : 400;
      return c.json({ error: { code: "E_INVALID_PARAMS", message } }, status);
    }
  }
  const id = (c: Context) => c.req.param("id") ?? "";
  app.post("/api/v1/alerts/telegram/:id/restart", (c) =>
    run(c, "alert.telegram.restart", (_body, user) => alerts.telegram.restart(id(c), user)),
  );
  app.get("/api/v1/alerts", (c) => run(c, "alert.list"));
  app.post("/api/v1/alerts/rules", (c) =>
    run(c, "alert.rule.create", (body) => alerts.engine.save(body)),
  );
  app.put("/api/v1/alerts/rules/:id", (c) =>
    run(c, "alert.rule.update", (body) => alerts.engine.save(body, id(c))),
  );
  app.delete("/api/v1/alerts/rules/:id", (c) =>
    run(c, "alert.rule.remove", () => alerts.engine.remove(id(c))),
  );
  app.post("/api/v1/alerts/incidents/:id/acknowledge", (c) =>
    run(c, "alert.acknowledge", () => alerts.engine.acknowledge(id(c))),
  );
  app.post("/api/v1/alerts/incidents/:id/silence", (c) =>
    run(c, "alert.silence", (body) => alerts.engine.silence(id(c), body["seconds"])),
  );
  app.post("/api/v1/alerts/channels/email", (c) =>
    run(c, "alert.channel.create", (body) => alerts.channels.saveEmail(body)),
  );
  app.put("/api/v1/alerts/channels/:id/email", (c) =>
    run(c, "alert.channel.update", (body) => alerts.channels.saveEmail(body, id(c))),
  );
  app.patch("/api/v1/alerts/channels/:id", (c) =>
    run(c, "alert.channel.enable", (body) => alerts.channels.enable(id(c), body["enabled"])),
  );
  app.delete("/api/v1/alerts/channels/:id", (c) =>
    run(c, "alert.channel.remove", () => {
      if (alerts.engine.rules().some((rule) => rule.channelIds.includes(id(c))))
        throw new AlertError(
          "This channel is selected by an alert rule. Edit that rule's destinations before removing it.",
          409,
        );
      alerts.channels.remove(id(c));
    }),
  );
  app.post("/api/v1/alerts/channels/:id/test", (c) =>
    run(c, "alert.channel.test", () => alerts.channels.test(id(c))),
  );
  app.post("/api/v1/alerts/telegram/setup", (c) =>
    run(c, "alert.telegram.start", (body, user) => alerts.telegram.start(body["token"], user)),
  );
  app.post("/api/v1/alerts/telegram/:id/poll", (c) =>
    run(c, "alert.telegram.poll", (_body, user) => alerts.telegram.poll(id(c), user)),
  );
  app.delete("/api/v1/alerts/telegram/:id", (c) =>
    run(c, "alert.telegram.cancel", (_body, user) => alerts.telegram.cancel(id(c), user)),
  );
  app.post("/api/v1/alerts/telegram/:id/confirm", (c) =>
    run(c, "alert.telegram.confirm", (body, user) => {
      const binding = alerts.telegram.confirm(id(c), user, body["chatId"]);
      alerts.channels.saveTelegram(body, binding);
      alerts.telegram.cancel(id(c), user);
    }),
  );
}
