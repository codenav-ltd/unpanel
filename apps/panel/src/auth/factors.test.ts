// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import { describe, it, expect } from "vitest";
import { openDatabase } from "../db/open.ts";
import { createEmailMethods } from "../email/store.ts";
import { createAuth } from "./service.ts";
import { createLoginSecurity } from "./security.ts";
import { createFactors, digest } from "./factors.ts";

async function fixture(totp = false) {
  const db = openDatabase(":memory:"),
    masterKey = randomBytes(32);
  let at = 1_700_000_030_000;
  const messages: string[] = [];
  const email = createEmailMethods({
    db,
    masterKey,
    send: async (_kind, _config, message) => {
      messages.push(message.text);
    },
  });
  const factors = createFactors({
    db,
    masterKey,
    email,
    publicUrl: () => "https://panel.example.com",
    now: () => at,
  });
  const auth = await createAuth({
    db,
    masterKey,
    setupToken: () => "fixture",
    clearSetupToken: () => undefined,
    security: createLoginSecurity({ db, masterKey, now: () => at }),
    factors,
    now: () => at,
  });
  const begun = await auth.beginSetup({
    token: "fixture",
    username: "operator",
    password: "fixture-auth-password",
  });
  if (!begun.ok) throw Error("setup failed");
  const code = (secret: string) =>
    generateHOTP(decodeBase32IgnorePadding(secret), BigInt(Math.floor(at / 30000)), 6);
  const setup = auth.confirmSetup({
    ticket: begun.ticket,
    totp,
    code: code(begun.secret),
    recoveryCode: begun.recoveryCodes[0] ?? "",
    ip: "127.0.0.1",
    userAgent: "test",
  });
  if (!setup.ok) throw Error("setup failed");
  const user = auth.sessionUser(setup.token);
  if (!user) throw Error("missing user");
  const session = digest(setup.token);
  const login = () =>
    auth.login({
      username: "operator",
      password: "fixture-auth-password",
      turnstileToken: "",
      ip: "127.0.0.1",
      userAgent: "test",
    });
  async function ticket(): Promise<string> {
    const result = await login();
    if (!result.ok || result.status !== "mfa_required") throw Error("Expected MFA");
    return result.ticket;
  }
  return {
    db,
    masterKey,
    auth,
    email,
    factors,
    messages,
    user,
    session,
    setup,
    begun,
    code,
    login,
    ticket,
    advance: (ms = 30000) => {
      at += ms;
    },
    unlock: () => factors.beginReauth(user.id, session, "fixture-auth-password"),
    close: () => auth.close(),
  };
}
describe("account authentication methods", () => {
  it("keeps legacy authentication fail-closed after enabling managed factors", async () => {
    const f = await fixture();
    try {
      await f.unlock();
      const draft = await f.factors.beginEnrollment(f.user.id, f.session, {
        kind: "totp",
        name: "Phone",
      });
      await f.factors.finishEnrollment(f.user.id, f.session, String(draft["ticket"]), {
        code: f.code(String(draft["secret"])),
        requireAfter: true,
      });
      const legacy = await createAuth({
        db: f.db,
        masterKey: f.masterKey,
        setupToken: () => null,
        clearSetupToken: () => undefined,
        security: createLoginSecurity({ db: f.db, masterKey: f.masterKey }),
      });
      const result = await legacy.login({
        username: "operator",
        password: "fixture-auth-password",
        turnstileToken: "",
        ip: "127.0.0.1",
        userAgent: "legacy",
      });
      expect(result).toMatchObject({ ok: true, status: "mfa_required" });
      if (!result.ok || result.status !== "mfa_required") throw Error("Expected legacy guard");
      expect(() =>
        legacy.confirmTotp({ ticket: result.ticket, code: "123456", ip: "", userAgent: "" }),
      ).toThrow();
    } finally {
      f.close();
    }
  });
  it("migrates existing TOTP without weakening policy or allowing replay", async () => {
    const f = await fixture(true);
    try {
      expect(f.factors.policy(f.user.id).required).toBe(true);
      expect(f.factors.view(f.user.id, f.session).methods).toHaveLength(1);
      expect(
        (f.db.prepare("SELECT totp_secret_enc FROM users").get() as { totp_secret_enc: unknown })
          .totp_secret_enc,
      ).toBe("managed-by-mfa-v2");
      const ticket = await f.ticket(),
        method = f.factors.allowed(f.user.id)[0];
      if (!method) throw Error("missing method");
      expect(
        (
          await f.auth.confirmMfa?.({
            ticket,
            methodId: method.id,
            code: f.code(f.begun.secret),
            ip: "",
            userAgent: "",
          })
        )?.ok,
      ).toBe(false);
      f.advance();
      expect(
        (
          await f.auth.confirmMfa?.({
            ticket,
            methodId: method.id,
            code: f.code(f.begun.secret),
            ip: "",
            userAgent: "",
          })
        )?.ok,
      ).toBe(true);
      expect(
        (
          await f.auth.confirmMfa?.({
            ticket,
            methodId: method.id,
            code: f.code(f.begun.secret),
            ip: "",
            userAgent: "",
          })
        )?.ok,
      ).toBe(false);
    } finally {
      f.close();
    }
  });
  it("requires session-bound reauthentication and prevents removing the last allowed method", async () => {
    const f = await fixture();
    try {
      await expect(
        f.factors.beginEnrollment(f.user.id, f.session, { kind: "totp", name: "Phone" }),
      ).rejects.toThrow("Verify your identity");
      expect(await f.unlock()).toEqual({ verified: true });
      const draft = await f.factors.beginEnrollment(f.user.id, f.session, {
        kind: "totp",
        name: "Phone",
      });
      expect(f.factors.view(f.user.id, f.session).methods).toHaveLength(0);
      await expect(
        f.factors.finishEnrollment(f.user.id, "other-session", String(draft["ticket"]), {
          code: f.code(String(draft["secret"])),
        }),
      ).rejects.toThrow();
      await f.factors.finishEnrollment(f.user.id, f.session, String(draft["ticket"]), {
        code: f.code(String(draft["secret"])),
        requireAfter: true,
      });
      const method = f.factors.allowed(f.user.id)[0];
      if (!method) throw Error("missing method");
      expect(() => f.factors.remove(f.user.id, f.session, method.id)).toThrow("last method");
      expect(() =>
        f.factors.savePolicy(f.user.id, f.session, { required: true, allowed: ["email"] }),
      ).toThrow("Set up an allowed");
      f.factors.rename(f.user.id, f.session, method.id, "Work phone");
      expect(f.factors.view(f.user.id, f.session).methods[0]?.name).toBe("Work phone");
      f.factors.savePolicy(f.user.id, f.session, { required: false, allowed: ["totp"] });
      f.factors.remove(f.user.id, f.session, method.id);
      expect(f.factors.view(f.user.id, f.session).methods).toHaveLength(0);
      expect(await f.login()).toMatchObject({ status: "ok" });
    } finally {
      f.close();
    }
  });
  it("verifies email ownership, limits sends, consumes codes and prevents deleting a referenced provider", async () => {
    const f = await fixture();
    try {
      await f.unlock();
      const deliveryId = f.email.save({
        name: "Operations",
        provider: "resend",
        from: "panel@example.com",
        secret: "fixture-provider-secret",
        enabled: true,
      });
      const draft = await f.factors.beginEnrollment(f.user.id, f.session, {
        kind: "email",
        name: "Mailbox",
        address: "operator@example.com",
        deliveryId,
      });
      const code = f.messages.at(-1)?.match(/\b\d{6}\b/)?.[0] ?? "";
      expect(code).toHaveLength(6);
      expect(JSON.stringify(draft)).not.toContain(code);
      expect(JSON.stringify(f.email.list())).not.toContain("fixture-provider-secret");
      await expect(
        f.factors.finishEnrollment(f.user.id, f.session, String(draft["ticket"]), {
          code: "wrong",
        }),
      ).rejects.toThrow("not valid");
      await f.factors.finishEnrollment(f.user.id, f.session, String(draft["ticket"]), {
        code,
        requireAfter: true,
      });
      expect(() => f.email.remove(deliveryId)).toThrow("in use");
      expect(() =>
        f.email.save(
          { name: "Operations", provider: "resend", from: "panel@example.com", enabled: false },
          deliveryId,
        ),
      ).toThrow("in use");
      const method = f.factors.allowed(f.user.id)[0];
      if (!method) throw Error("missing method");
      const ticket = await f.ticket();
      await expect(f.auth.challengeMfa?.(ticket, method.id)).rejects.toThrow("Wait a minute");
      f.advance(60001);
      await f.auth.challengeMfa?.(ticket, method.id);
      const loginCode = f.messages.at(-1)?.match(/\b\d{6}\b/)?.[0] ?? "";
      const input = { ticket, methodId: method.id, code: loginCode, ip: "", userAgent: "" };
      const results = await Promise.all([f.auth.confirmMfa?.(input), f.auth.confirmMfa?.(input)]);
      expect(results.filter((r) => r?.ok)).toHaveLength(1);
    } finally {
      f.close();
    }
  });
  it("binds factor challenges to the ticket and caps failed attempts", async () => {
    const f = await fixture(true);
    try {
      const method = f.factors.allowed(f.user.id)[0];
      if (!method) throw Error("missing method");
      let ticket = await f.ticket();
      for (let i = 0; i < 5; i++)
        expect(
          (
            await f.auth.confirmMfa?.({
              ticket,
              methodId: method.id,
              code: "invalid",
              ip: "",
              userAgent: "",
            })
          )?.ok,
        ).toBe(false);
      f.advance();
      expect(
        (
          await f.auth.confirmMfa?.({
            ticket,
            methodId: method.id,
            code: f.code(f.begun.secret),
            ip: "",
            userAgent: "",
          })
        )?.ok,
      ).toBe(false);
      ticket = await f.ticket();
      f.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(f.user.id);
      expect(
        (
          await f.auth.confirmMfa?.({
            ticket,
            methodId: method.id,
            code: f.code(f.begun.secret),
            ip: "",
            userAgent: "",
          })
        )?.ok,
      ).toBe(false);
    } finally {
      f.close();
    }
  });
  it("uses single-use recovery codes and requires a factor for reauthentication when policy is required", async () => {
    const f = await fixture(true);
    try {
      const request = await f.unlock();
      expect(request.verified).toBe(false);
      await f.factors.finishReauth(f.user.id, f.session, request.ticket ?? "", "recovery", {
        code: f.begun.recoveryCodes[0],
      });
      expect(f.factors.view(f.user.id, f.session).elevated).toBe(true);
      const codes = f.factors.recoveryCodes(f.user.id, f.session);
      expect(codes).toHaveLength(10);
      let ticket = await f.ticket();
      expect(
        (
          await f.auth.confirmMfa?.({
            ticket,
            methodId: "recovery",
            code: codes[0] ?? "",
            ip: "",
            userAgent: "",
          })
        )?.ok,
      ).toBe(true);
      ticket = await f.ticket();
      expect(
        (
          await f.auth.confirmMfa?.({
            ticket,
            methodId: "recovery",
            code: codes[0] ?? "",
            ip: "",
            userAgent: "",
          })
        )?.ok,
      ).toBe(false);
      f.advance(300001);
      expect(() => f.factors.recoveryCodes(f.user.id, f.session)).toThrow("Verify your identity");
    } finally {
      f.close();
    }
  });
  it("expires enrollment and rejects forged passkey registrations without creating credentials", async () => {
    const f = await fixture();
    try {
      await f.unlock();
      const draft = await f.factors.beginEnrollment(f.user.id, f.session, {
        kind: "passkey",
        name: "Laptop",
      });
      await expect(
        f.factors.finishEnrollment(f.user.id, f.session, String(draft["ticket"]), {
          response: { id: "forged", response: {} },
        }),
      ).rejects.toThrow("verification failed");
      expect(f.factors.view(f.user.id, f.session).methods).toHaveLength(0);
      f.advance(300001);
      await expect(
        f.factors.finishEnrollment(f.user.id, f.session, String(draft["ticket"]), {}),
      ).rejects.toThrow();
    } finally {
      f.close();
    }
  });
});
