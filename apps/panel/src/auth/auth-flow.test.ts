// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import { describe, expect, it } from "vitest";
import { createAuth } from "./service.ts";
import { createLoginSecurity } from "./security.ts";
import { openDatabase } from "../db/open.ts";

describe("setup and login", () => {
  it("enrolls TOTP, then requires a fresh code on the next sign-in", async () => {
    let now = 1_700_000_030_000;
    let token: string | null = "st_test";
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    const auth = await createAuth({
      db,
      masterKey,
      setupToken: () => token,
      clearSetupToken: () => {
        token = null;
      },
      security: createLoginSecurity({ db, masterKey, now: () => now }),
      now: () => now,
    });

    try {
      const begun = await auth.beginSetup({
        token: "st_test",
        username: "ada",
        password: "correct-horse",
      });
      expect(begun.ok).toBe(true);
      if (!begun.ok) return;
      const secret = decodeBase32IgnorePadding(begun.secret);
      const first = codeAt(secret, now);
      const recovery = begun.recoveryCodes[0];
      expect(recovery).toBeTruthy();
      const confirmed = auth.confirmSetup({
        ticket: begun.ticket,
        totp: true,
        code: first,
        recoveryCode: recovery ?? "",
        ip: "127.0.0.1",
        userAgent: "test",
      });
      expect(confirmed.ok).toBe(true);
      expect(token).toBeNull();
      expect(auth.initialized()).toBe(true);
      if (!confirmed.ok) return;
      expect(auth.sessionUser(confirmed.token)?.username).toBe("ada");

      const again = await auth.beginSetup({
        token: "st_test",
        username: "ada",
        password: "correct-horse",
      });
      expect(again.ok).toBe(false);

      const login = await auth.login({
        username: "ada",
        password: "wrong-password",
        turnstileToken: "",
        ip: "127.0.0.1",
        userAgent: "test",
      });
      expect(login.ok).toBe(false);
      if (!login.ok) expect(login.message).toBe("Invalid username or password.");

      const missing = await auth.login({
        username: "nobody",
        password: "correct-horse",
        turnstileToken: "",
        ip: "127.0.0.1",
        userAgent: "test",
      });
      expect(missing.ok).toBe(false);

      const pending = await auth.login({
        username: "ada",
        password: "correct-horse",
        turnstileToken: "",
        ip: "127.0.0.1",
        userAgent: "test",
      });
      expect(pending.ok && pending.status === "mfa_required").toBe(true);
      if (!pending.ok || pending.status !== "mfa_required") return;
      const replay = auth.confirmTotp({
        ticket: pending.ticket,
        code: first,
        ip: "127.0.0.1",
        userAgent: "test",
      });
      expect(replay.ok).toBe(false);

      now += 30_000;
      const second = auth.confirmTotp({
        ticket: pending.ticket,
        code: codeAt(secret, now),
        ip: "127.0.0.1",
        userAgent: "test",
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      auth.logout(second.token);
      expect(auth.sessionUser(second.token)).toBeNull();
    } finally {
      auth.close();
    }
  });

  it("lets setup finish without TOTP and signs in with the password alone", async () => {
    let token: string | null = "st_test";
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    const auth = await createAuth({
      db,
      masterKey,
      setupToken: () => token,
      clearSetupToken: () => {
        token = null;
      },
      security: createLoginSecurity({ db, masterKey }),
    });
    try {
      const begun = await auth.beginSetup({
        token: "st_test",
        username: "ada",
        password: "correct-horse",
      });
      expect(begun.ok).toBe(true);
      if (!begun.ok) return;
      const confirmed = auth.confirmSetup({
        ticket: begun.ticket,
        totp: false,
        code: "",
        recoveryCode: "",
        ip: "127.0.0.1",
        userAgent: "test",
      });
      expect(confirmed.ok).toBe(true);
      const signedIn = await auth.login({
        username: "ada",
        password: "correct-horse",
        turnstileToken: "",
        ip: "127.0.0.1",
        userAgent: "test",
      });
      expect(signedIn.ok && signedIn.status === "ok").toBe(true);
      if (!signedIn.ok || signedIn.status !== "ok") return;
      expect(auth.sessionUser(signedIn.token)?.username).toBe("ada");
    } finally {
      auth.close();
    }
  });

  it("changes the password after the current one is checked", async () => {
    let token: string | null = "st_test";
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    const auth = await createAuth({
      db,
      masterKey,
      setupToken: () => token,
      clearSetupToken: () => {
        token = null;
      },
      security: createLoginSecurity({ db, masterKey }),
    });
    try {
      const begun = await auth.beginSetup({
        token: "st_test",
        username: "ada",
        password: "correct-horse",
      });
      expect(begun.ok).toBe(true);
      if (!begun.ok) return;
      const confirmed = auth.confirmSetup({
        ticket: begun.ticket,
        totp: false,
        code: "",
        recoveryCode: "",
        ip: "127.0.0.1",
        userAgent: "test",
      });
      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok) return;
      const user = auth.sessionUser(confirmed.token);
      expect(user).not.toBeNull();
      if (!user) return;
      const denied = await auth.changePassword({
        userId: user.id,
        current: "wrong-horse",
        next: "new-correct-horse",
      });
      expect(denied.ok).toBe(false);
      const changed = await auth.changePassword({
        userId: user.id,
        current: "correct-horse",
        next: "new-correct-horse",
      });
      expect(changed.ok).toBe(true);
      const oldLogin = await auth.login({
        username: "ada",
        password: "correct-horse",
        turnstileToken: "",
        ip: "127.0.0.1",
        userAgent: "test",
      });
      expect(oldLogin.ok).toBe(false);
      const nextLogin = await auth.login({
        username: "ada",
        password: "new-correct-horse",
        turnstileToken: "",
        ip: "127.0.0.1",
        userAgent: "test",
      });
      expect(nextLogin.ok && nextLogin.status === "ok").toBe(true);
    } finally {
      auth.close();
    }
  });

  it("requires a server-verified Turnstile token when it is enabled", async () => {
    let setupToken: string | null = "st_test";
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    const security = createLoginSecurity({ db, masterKey });
    const seen: string[] = [];
    const auth = await createAuth({
      db,
      masterKey,
      setupToken: () => setupToken,
      clearSetupToken: () => {
        setupToken = null;
      },
      security,
      verifyTurnstile: async ({ token }) => {
        seen.push(token);
        return token === "valid-token";
      },
    });
    try {
      const begun = await auth.beginSetup({
        token: "st_test",
        username: "ada",
        password: "correct-horse",
      });
      expect(begun.ok).toBe(true);
      if (!begun.ok) return;
      expect(
        auth.confirmSetup({
          ticket: begun.ticket,
          totp: false,
          code: "",
          recoveryCode: "",
          ip: "127.0.0.1",
          userAgent: "test",
        }).ok,
      ).toBe(true);
      security.update(
        { turnstile: { enabled: true, siteKey: "site-key", secret: "secret-key" } },
        "ada",
      );

      const missing = await auth.login({
        username: "ada",
        password: "correct-horse",
        turnstileToken: "",
        ip: "127.0.0.1",
        userAgent: "test",
      });
      expect(missing.ok ? "ok" : missing.code).toBe("E_TURNSTILE_REQUIRED");
      expect(seen).toEqual([]);

      const failed = await auth.login({
        username: "ada",
        password: "correct-horse",
        turnstileToken: "expired-token",
        ip: "127.0.0.1",
        userAgent: "test",
      });
      expect(failed.ok ? "ok" : failed.code).toBe("E_TURNSTILE_FAILED");

      const signedIn = await auth.login({
        username: "ada",
        password: "correct-horse",
        turnstileToken: "valid-token",
        ip: "127.0.0.1",
        userAgent: "test",
      });
      expect(signedIn.ok && signedIn.status === "ok").toBe(true);
      expect(seen).toEqual(["expired-token", "valid-token"]);
    } finally {
      auth.close();
    }
  });
});

function codeAt(secret: Uint8Array, nowMs: number): string {
  return generateHOTP(secret, BigInt(Math.floor(nowMs / 1000 / 30)), 6);
}
