// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { Context, Hono } from "hono";
import type { Audit } from "../audit/log.ts";
import { CertificateError } from "./material.ts";
import type { Certificates, CertificateView } from "./store.ts";

export function registerCertificateApi(
  app: Hono,
  options: {
    certificates: Certificates;
    username: (c: Context) => string | null;
    audit: Audit;
    publicUrl?: () => string;
  },
) {
  const { certificates, audit } = options;
  async function run(
    c: Context,
    action: string,
    work: (
      user: string,
      body: Record<string, unknown>,
    ) => Promise<CertificateView> | CertificateView,
  ): Promise<Response> {
    const user = options.username(c);
    if (!user)
      return c.json(
        { error: { code: "E_UNAUTHENTICATED", message: "Sign in to manage certificates." } },
        401,
      );
    const origin = c.req.header("origin");
    if (
      c.req.method !== "GET" &&
      origin &&
      origin !== new URL(c.req.url).origin &&
      origin !== options.publicUrl?.()
    ) {
      return c.json(
        {
          error: {
            code: "E_FORBIDDEN",
            message: "Open this panel directly before changing its certificates.",
          },
        },
        403,
      );
    }
    let body: Record<string, unknown> = {};
    if (c.req.method !== "GET" && c.req.method !== "DELETE" && !c.req.path.endsWith("/renew")) {
      try {
        const value: unknown = await c.req.json();
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        body = value as Record<string, unknown>;
      } catch {
        return c.json(
          {
            error: {
              code: "E_INVALID_PARAMS",
              message: "Use a JSON object for certificate settings.",
            },
          },
          400,
        );
      }
    }
    try {
      return c.json({ data: await work(user, body) });
    } catch (error) {
      if (!(error instanceof CertificateError)) throw error;
      audit.record({
        action,
        result: "error",
        actorKind: "user",
        actorId: user,
        params: { detail: error.message },
        errorCode: "E_INVALID_PARAMS",
      });
      const status = error.status === 404 ? 404 : error.status === 409 ? 409 : 400;
      return c.json(
        {
          error: {
            code: status === 409 ? "E_CONFLICT" : "E_INVALID_PARAMS",
            message: error.message,
          },
        },
        status,
      );
    }
  }
  const string = (body: Record<string, unknown>, key: string): string =>
    typeof body[key] === "string" ? body[key] : "";
  app.get("/api/v1/certificates", (c) => run(c, "certificate.list", () => certificates.view()));
  app.post("/api/v1/certificates/selfsigned", (c) =>
    run(c, "certificate.generate", (_user, body) => certificates.generate(string(body, "host"))),
  );
  app.post("/api/v1/certificates/import", (c) =>
    run(c, "certificate.import", (_user, body) =>
      certificates.upload(string(body, "host"), string(body, "cert"), string(body, "key")),
    ),
  );
  app.post("/api/v1/certificates/issue", (c) =>
    run(c, "certificate.issue", (_user, body) =>
      certificates.issue({
        domain: string(body, "domain"),
        email: string(body, "email"),
        staging: body["staging"] === true,
        termsAgreed: body["termsAgreed"] === true,
      }),
    ),
  );
  app.post("/api/v1/certificates/:id/activate", (c) =>
    run(c, "certificate.activate", (user, body) =>
      certificates.activate(c.req.param("id") ?? "", string(body, "publicUrl"), user),
    ),
  );
  app.post("/api/v1/certificates/:id/renew", (c) =>
    run(c, "certificate.renew", () => certificates.renew(c.req.param("id") ?? "")),
  );
  app.patch("/api/v1/certificates/:id", (c) =>
    run(c, "certificate.autoRenew", (_user, body) => {
      if (typeof body["autoRenew"] !== "boolean")
        throw new CertificateError("Automatic renewal must be on or off.");
      return certificates.autoRenew(c.req.param("id") ?? "", body["autoRenew"]);
    }),
  );
  app.delete("/api/v1/certificates/:id", (c) =>
    run(c, "certificate.remove", () => certificates.remove(c.req.param("id") ?? "")),
  );
}
