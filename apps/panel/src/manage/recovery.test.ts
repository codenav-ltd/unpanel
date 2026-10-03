// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAccess } from "../auth/access.ts";
import { createAuth } from "../auth/service.ts";
import { createFactors } from "../auth/factors.ts";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import { createLoginSecurity } from "../auth/security.ts";
import { createAudit } from "../audit/log.ts";
import { openDatabase } from "../db/open.ts";
import { createEmailMethods } from "../email/store.ts";
import { recoveryStore } from "./recovery.ts";

async function fixture() {
  const db = openDatabase(":memory:"),
    masterKey = randomBytes(32);
  const passwordHash = await hashPassword("fixture-old-password");
  db.prepare(
    "INSERT INTO users(id,username,password_hash,status,created_at,updated_at) VALUES (?,?,?,'active',1,1)",
  ).run("u", "alice", passwordHash);
  db.prepare(
    "INSERT INTO users(id,username,password_hash,status,created_at,updated_at) VALUES (?,?,?,'member',2,2)",
  ).run("v", "viewer", passwordHash);
  const access = createAccess(db);
  db.prepare("INSERT INTO user_access VALUES ('v','viewer','[\"node-1\"]',1)").run();
  const email = createEmailMethods({ db, masterKey, send: async () => undefined });
  const factors = createFactors({
    db,
    masterKey,
    email,
    publicUrl: () => "https://panel.example.com",
  });
  const security = createLoginSecurity({ db, masterKey });
  const auth = await createAuth({
    db,
    masterKey,
    access,
    factors,
    security,
    setupToken: () => null,
    clearSetupToken: () => undefined,
  });
  const store = recoveryStore(db);
  const login = (password = "fixture-old-password", username = "alice") =>
    auth.login({ username, password, turnstileToken: "", ip: "127.0.0.1", userAgent: "test" });
  return { db, masterKey, security, auth, store, login, factors, email };
}

describe("local sign-in recovery", () => {
  it("disables only Turnstile and the running authentication service observes it immediately", async () => {
    const f = await fixture();
    try {
      f.security.update(
        {
          turnstile: {
            enabled: true,
            siteKey: "fixture-site-key",
            secret: "fixture-private-secret",
          },
        },
        "u",
      );
      const secret = f.db
        .prepare("SELECT value_json FROM settings WHERE key='security.turnstile.secret'")
        .get();
      const restrictions = f.security.view().loginRestrictions;
      expect(await f.login()).toMatchObject({ ok: false, code: "E_TURNSTILE_REQUIRED" });
      f.store.disableTurnstile();
      expect(await f.login()).toMatchObject({ ok: true, status: "ok" });
      expect(f.security.view()).toMatchObject({
        turnstile: { enabled: false, siteKey: "fixture-site-key", secretConfigured: true },
        loginRestrictions: restrictions,
      });
      expect(
        f.db.prepare("SELECT value_json FROM settings WHERE key='security.turnstile.secret'").get(),
      ).toEqual(secret);
      expect(f.store.security()).not.toMatch(/fixture-private-secret|fixture-site-key/);
      expect(createAudit(f.db).list(1)[0]?.action).toBe("security.turnstile.disable");
    } finally {
      f.auth.close();
    }
  });
  it("unlocks one scope without clearing other bans or login restrictions", async () => {
    const f = await fixture();
    try {
      f.db.exec(
        "INSERT INTO auth_bans VALUES ('panel','panel',10,1,NULL),('ip','203.0.113.1',10,1,NULL),('ip','203.0.113.2',10,1,NULL); INSERT INTO auth_attempts VALUES ('panel','panel',10,1,NULL),('ip','203.0.113.1',10,1,NULL),('user','alice',3,1,NULL)",
      );
      const policy = f.security.view();
      f.store.unlock();
      expect(f.db.prepare("SELECT * FROM auth_bans WHERE kind='panel'").all()).toHaveLength(0);
      expect(f.db.prepare("SELECT * FROM auth_bans WHERE kind='ip'").all()).toHaveLength(2);
      f.store.unban("203.0.113.1");
      expect(f.db.prepare("SELECT key FROM auth_bans").all()).toEqual([{ key: "203.0.113.2" }]);
      expect(f.db.prepare("SELECT scope FROM auth_attempts").all()).toEqual([{ scope: "user" }]);
      expect(f.security.view()).toEqual(policy);
    } finally {
      f.auth.close();
    }
  });
  it("resets a password with Argon2, revokes sessions and pending proofs, and preserves demo access and MFA", async () => {
    const f = await fixture();
    try {
      const session = await f.login("fixture-old-password", "viewer");
      if (!session.ok || session.status !== "ok") throw new Error("Fixture login failed");
      f.db.exec(
        "INSERT INTO pending_logins(id,user_id,expires_at) VALUES ('pending','v',9999999999); INSERT INTO mfa_proofs VALUES ('proof','v','method','{}',9999999999,0); INSERT INTO mfa_methods VALUES ('method','v','totp','app','{}',NULL,1,NULL)",
      );
      const access = f.db.prepare("SELECT * FROM user_access WHERE user_id='v'").get();
      await f.store.resetPassword(f.store.user("VIEWER"), "fixture-new-password");
      expect(f.auth.sessionUser(session.token)).toBeNull();
      expect(await f.login("fixture-old-password", "viewer")).toMatchObject({ ok: false });
      expect(await f.login("fixture-new-password", "viewer")).toMatchObject({ ok: true });
      expect(f.db.prepare("SELECT * FROM pending_logins").all()).toHaveLength(0);
      expect(f.db.prepare("SELECT * FROM mfa_proofs").all()).toHaveLength(0);
      expect(f.db.prepare("SELECT * FROM mfa_methods").all()).toHaveLength(1);
      expect(f.db.prepare("SELECT * FROM user_access WHERE user_id='v'").get()).toEqual(access);
      expect(f.db.prepare("SELECT status FROM users WHERE id='v'").get()?.["status"]).toBe(
        "member",
      );
      const stored = f.db.prepare("SELECT password_hash FROM users WHERE id='v'").get()?.[
        "password_hash"
      ];
      expect(String(stored)).toMatch(/^\$argon2id\$/);
      expect(await verifyPassword(String(stored), "fixture-new-password")).toBe(true);
      expect(JSON.stringify(createAudit(f.db).list(10))).not.toMatch(
        /fixture-new-password|argon2id/,
      );
    } finally {
      f.auth.close();
    }
  });
  it("rejects weak passwords and concurrent account changes without revoking sessions", async () => {
    const f = await fixture();
    try {
      const before = f.store.user("alice");
      await expect(f.store.resetPassword(before, "password123")).rejects.toThrow(/common/);
      f.db.prepare("UPDATE users SET status='disabled' WHERE id='u'").run();
      await expect(f.store.resetPassword(before, "fixture-new-password")).rejects.toThrow(
        /changed during recovery/,
      );
      expect(f.store.user("alice").password_hash).toBe(before.password_hash);
      expect(createAudit(f.db).list(10)).toHaveLength(0);
    } finally {
      f.auth.close();
    }
  });
  it("removes every factor, recovery code and only its email references, and leaves other accounts protected", async () => {
    const f = await fixture();
    try {
      f.db.exec(
        "INSERT INTO mfa_methods VALUES ('totp','u','totp','app','{}',NULL,1,NULL),('passkey','u','passkey','key','{}',NULL,1,NULL),('mail','u','email','email','{}',NULL,1,NULL),('other','v','totp','app','{}',NULL,1,NULL); INSERT INTO mfa_policies VALUES ('u',1,'[\"totp\",\"passkey\",\"email\"]'),('v',1,'[\"totp\"]'); UPDATE users SET totp_secret_enc='managed-by-mfa-v2' WHERE id IN ('u','v'); INSERT INTO recovery_codes VALUES ('r','u','hash',NULL,1),('s','v','hash',NULL,1); INSERT INTO pending_logins(id,user_id,expires_at) VALUES ('p','u',9999999999),('q','v',9999999999)",
      );
      const method = f.email.save({
        name: "Fixture delivery",
        enabled: true,
        provider: "resend",
        from: "panel@example.com",
        secret: "fixture-email-key",
      });
      f.email.bind("mfa:mail", method);
      f.email.bind("alert:channel", method);
      f.store.resetFactors(f.store.user("alice"));
      expect(f.factors.policy("u")).toEqual({
        required: false,
        allowed: ["totp", "passkey", "email"],
      });
      expect(await f.login()).toMatchObject({ ok: true, status: "ok" });
      expect(f.db.prepare("SELECT id FROM mfa_methods").all()).toEqual([{ id: "other" }]);
      expect(f.db.prepare("SELECT id FROM recovery_codes").all()).toEqual([{ id: "s" }]);
      expect(f.db.prepare("SELECT consumer FROM email_method_refs").all()).toEqual([
        { consumer: "alert:channel" },
      ]);
      expect(f.db.prepare("SELECT id FROM pending_logins").all()).toEqual([{ id: "q" }]);
      expect(
        f.db.prepare("SELECT totp_secret_enc FROM users WHERE id='v'").get()?.["totp_secret_enc"],
      ).toBe("managed-by-mfa-v2");
    } finally {
      f.auth.close();
    }
  });
  it("rolls back recovery when the audit append cannot succeed", async () => {
    const f = await fixture();
    try {
      f.security.update({ turnstile: { enabled: true, siteKey: "site", secret: "private" } }, "u");
      createAudit(f.db);
      f.db.exec(
        "CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'fixture refusal'); END;",
      );
      expect(() => f.store.disableTurnstile()).toThrow(/fixture refusal/);
      expect(f.security.view().turnstile.enabled).toBe(true);
    } finally {
      f.auth.close();
    }
  });
});
