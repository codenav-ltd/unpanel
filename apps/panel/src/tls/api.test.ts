// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { createAudit } from "../audit/log.ts";
import { openDatabase } from "../db/open.ts";
import { createSettings } from "../settings/store.ts";
import { registerCertificateApi } from "./api.ts";
import { createCertificates } from "./store.ts";
import { selfSignedCertificate } from "./material.ts";

it("protects certificate routes, validates requests, and returns no private key", async () => {
  const db = openDatabase(":memory:");
  const settings = createSettings(db);
  const certificates = createCertificates({
    db,
    settings,
    masterKey: randomBytes(32),
    port: () => 28517,
    apply: async () => undefined,
    issue: async (input) => selfSignedCertificate(input.domain),
    record: () => undefined,
  });
  const app = new Hono();
  registerCertificateApi(app, {
    certificates,
    audit: createAudit(db),
    username: (c) => (c.req.header("cookie") === "unpanel_sid=test-session" ? "owner" : null),
  });
  const headers = { cookie: "unpanel_sid=test-session", "content-type": "application/json" };
  try {
    for (const [path, method] of [
      ["", "GET"],
      ["/selfsigned", "POST"],
      ["/import", "POST"],
      ["/issue", "POST"],
      ["/id/activate", "POST"],
      ["/id/renew", "POST"],
      ["/id", "PATCH"],
      ["/id", "DELETE"],
    ] as const) {
      expect((await app.request(`/api/v1/certificates${path}`, { method })).status).toBe(401);
    }
    const crossOrigin = await app.request("/api/v1/certificates/selfsigned", {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body: JSON.stringify({ host: "localhost" }),
    });
    expect(crossOrigin.status).toBe(403);
    const malformed = await app.request("/api/v1/certificates/selfsigned", {
      method: "POST",
      headers,
      body: "[]",
    });
    expect(malformed.status).toBe(400);
    const response = await app.request("/api/v1/certificates/selfsigned", {
      method: "POST",
      headers,
      body: JSON.stringify({ host: "127.0.0.1" }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain("material_enc");
    const certificate = certificates.view().certificates[0];
    if (!certificate) throw new Error("No certificate");
    await certificates.activate(certificate.id, "https://127.0.0.1:28517", "owner");
    expect(() => certificates.validatePublicUrl("http://127.0.0.1:28517")).toThrow(
      "HTTPS is enabled",
    );
    expect(() => certificates.validatePublicUrl("https://wrong.example.com:28517")).toThrow(
      "does not cover",
    );
    const gone = await app.request(`/api/v1/certificates/${certificate.id}`, {
      method: "DELETE",
      headers,
    });
    expect(gone.status).toBe(409);
  } finally {
    db.close();
  }
});
