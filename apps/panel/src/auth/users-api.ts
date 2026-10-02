// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { Hono, Context } from "hono";
import type { Access } from "./access.ts";
import type { Auth } from "./service.ts";
import type { Audit } from "../audit/log.ts";
import { digest } from "./factors.ts";
import { AccountError } from "./account-error.ts";

export function registerUsersApi(
  app: Hono,
  options: { access: Access; auth: Auth; audit: Audit; token: (c: Context) => string | null },
): void {
  app.get("/api/v1/user-mode", (c) => c.json({ data: { mode: options.access.mode() } }));
  app.post("/api/v1/user-mode", async (c) => {
    const token = options.token(c),
      user = options.auth.sessionUser(token);
    if (!user || !token) throw new AccountError("Sign in to change user mode.", 401);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AccountError("Choose a user mode.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new AccountError("Choose a user mode.");
    const input = body as Record<string, unknown>;
    options.access.setMode(user.id, digest(token), input["mode"], input["confirmation"]);
    options.audit.record({
      action: "user.mode",
      result: "ok",
      actorKind: "user",
      actorId: user.username,
      params: { mode: options.access.mode() },
    });
    return c.json({ data: { mode: options.access.mode() } });
  });
  for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
    const path = "/api/v1/users" + (["PATCH", "DELETE"].includes(method) ? "/:id" : "");
    app.on(method, path, async (c) => {
      const token = options.token(c),
        user = options.auth.sessionUser(token);
      if (!user || !token || options.access.get(user.id).role !== "owner")
        throw new AccountError("Only owners can manage users.", 403);
      if (method === "GET") return c.json({ data: options.access.list() });
      const id = c.req.param("id");
      if (method === "DELETE") options.access.remove(user.id, digest(token), id ?? "");
      else {
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          throw new AccountError("Enter valid user settings.");
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new AccountError("Enter valid user settings.");
        await options.access.save(user.id, digest(token), body as Record<string, unknown>, id);
      }
      options.audit.record({
        action: method === "DELETE" ? "user.remove" : "user.configure",
        result: "ok",
        actorKind: "user",
        actorId: user.username,
        target: id ?? "new user",
      });
      return c.json({ data: options.access.list() });
    });
  }
}
