// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { Context, Hono } from "hono";
import type { Auth, SessionUser } from "./service.ts";
import { AccountError } from "./account-error.ts";
import { digest, type Factors } from "./factors.ts";
import type { EmailMethods } from "../email/store.ts";
import type { Audit } from "../audit/log.ts";
import { DeliveryError } from "../alerts/providers.ts";

export function registerAccountApi(
  app: Hono,
  options: {
    auth: Auth;
    factors: Factors;
    email: EmailMethods;
    audit: Audit;
    token: (c: Context) => string | null;
    publicUrl: () => string;
  },
) {
  const { factors, email } = options;
  const tests = new Map<string, number>();
  type Action = (
    user: SessionUser,
    session: string,
    body: Record<string, unknown>,
    c: Context,
  ) => unknown | Promise<unknown>;
  function route(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, action: Action): void {
    app.on(method, path, async (c) => {
      const token = options.token(c),
        user = options.auth.sessionUser(token);
      if (!user || !token)
        return c.json(
          { error: { code: "E_UNAUTHENTICATED", message: "Sign in to manage account security." } },
          401,
        );
      const origin = c.req.header("origin");
      if (
        method !== "GET" &&
        origin &&
        origin !== new URL(c.req.url).origin &&
        origin !== options.publicUrl()
      )
        return c.json(
          {
            error: {
              code: "E_FORBIDDEN",
              message: "Open the panel directly to change account security.",
            },
          },
          403,
        );
      try {
        const input: unknown = method === "GET" || method === "DELETE" ? {} : await c.req.json();
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new AccountError("Enter valid settings.");
        const data = await action(user, digest(token), input as Record<string, unknown>, c);
        if (method !== "GET")
          options.audit.record({
            action: path.startsWith("/api/v1/email") ? "email.configure" : "auth.security",
            result: "ok",
            actorKind: "user",
            actorId: user.username,
            target: path,
          });
        return c.json({ data: data ?? factors.view(user.id, digest(token)) });
      } catch (error) {
        const known = error instanceof AccountError || error instanceof DeliveryError;
        const status =
          error instanceof AccountError ? error.status : error instanceof SyntaxError ? 400 : 503;
        const message = known
          ? error.message
          : status === 400
            ? "Enter valid settings."
            : "The security request could not complete. Retry, or inspect the panel logs.";
        if (method !== "GET")
          options.audit.record({
            action: "auth.security",
            result: "denied",
            actorKind: "user",
            actorId: user.username,
            target: path,
            errorCode: "E_SECURITY_REQUEST",
          });
        return c.json({ error: { code: "E_SECURITY_REQUEST", message } }, status);
      }
    });
  }
  const string = (body: Record<string, unknown>, key: string) =>
    typeof body[key] === "string" ? body[key] : "";
  route("GET", "/api/v1/me/security", (user, session) => factors.view(user.id, session));
  route("GET", "/api/v1/me/email-methods", () =>
    email
      .list()
      .filter((method) => method.enabled)
      .map(({ id, name, enabled }) => ({ id, name, enabled })),
  );
  route("POST", "/api/v1/me/security/reauth", (user, session, body) =>
    factors.beginReauth(user.id, session, string(body, "password")),
  );
  route("POST", "/api/v1/me/security/reauth/challenge", (user, session, body) =>
    factors.reauthChallenge(user.id, session, string(body, "ticket"), string(body, "methodId")),
  );
  route("POST", "/api/v1/me/security/reauth/verify", async (user, session, body) => {
    await factors.finishReauth(
      user.id,
      session,
      string(body, "ticket"),
      string(body, "methodId"),
      body,
    );
  });
  route("POST", "/api/v1/me/security/enroll", (user, session, body) =>
    factors.beginEnrollment(user.id, session, body),
  );
  route("POST", "/api/v1/me/security/enroll/verify", async (user, session, body) => {
    await factors.finishEnrollment(user.id, session, string(body, "ticket"), body);
  });
  route("PATCH", "/api/v1/me/security/policy", (user, session, body) => {
    factors.savePolicy(user.id, session, body);
  });
  route("PATCH", "/api/v1/me/security/methods/:id", (user, session, body, c) => {
    factors.rename(user.id, session, c.req.param("id") ?? "", body["name"]);
  });
  route("DELETE", "/api/v1/me/security/methods/:id", (user, session, _body, c) => {
    factors.remove(user.id, session, c.req.param("id") ?? "");
  });
  route("POST", "/api/v1/me/security/recovery", (user, session) => ({
    codes: factors.recoveryCodes(user.id, session),
  }));
  route("GET", "/api/v1/email-methods", () => email.list());
  route("POST", "/api/v1/email-methods", (_user, _session, body) => {
    email.save(body);
    return email.list();
  });
  route("PATCH", "/api/v1/email-methods/:id", (_user, _session, body, c) => {
    email.save(body, c.req.param("id") ?? "");
    return email.list();
  });
  route("DELETE", "/api/v1/email-methods/:id", (_user, _session, _body, c) => {
    email.remove(c.req.param("id") ?? "");
    return email.list();
  });
  route("POST", "/api/v1/email-methods/:id/test", async (_user, _session, body, c) => {
    const id = c.req.param("id") ?? "";
    if (!email.available(id)) throw new AccountError("Choose an enabled email delivery method.");
    const last = tests.get(id) ?? 0;
    if (last > Date.now() - 30_000)
      throw new AccountError("Wait 30 seconds before sending another test.", 429);
    for (const [key, at] of tests) if (at < Date.now() - 30_000) tests.delete(key);
    tests.set(id, Date.now());
    await email.send(id, [string(body, "to")], {
      title: `Unpanel · Email delivery test`,
      text: "Your shared email delivery method is connected.",
      key: "email-test",
    });
    return { sent: true };
  });
}
