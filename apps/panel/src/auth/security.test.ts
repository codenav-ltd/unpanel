// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/open.ts";
import { createLoginSecurity, LoginSecurityError, unlockPanelLock } from "./security.ts";

describe("login security", () => {
  it("keeps IP and panel warnings during a username cooldown without counting blocked attempts", () => {
    let now = 1_700_000_000_000;
    const db = openDatabase(":memory:");
    const security = createLoginSecurity({ db, masterKey: randomBytes(32), now: () => now });
    try {
      security.update({ loginRestrictions: { banPanel: { enabled: true, attempts: 12 } } }, "ada");
      security.noteFailure("192.0.2.1", "ada");
      security.noteFailure("192.0.2.1", "ada");
      const failed = security.noteFailure("192.0.2.1", "ada");
      expect(failed).toMatchObject({
        ipAttemptsLeft: 7,
        panelAttemptsLeft: 9,
        block: { code: "E_RATE_LIMITED", retryAfter: 30, ipAttemptsLeft: 7, panelAttemptsLeft: 9 },
      });
      for (let i = 0; i < 3; i++)
        expect(security.beforeAttempt("192.0.2.1", "ADA")).toEqual(failed.block);
      expect(
        db
          .prepare("SELECT failures FROM auth_attempts")
          .all()
          .map((row) => row["failures"]),
      ).toEqual([3, 3, 3]);
      now += 30_000;
      expect(security.beforeAttempt("192.0.2.1", "ada")).toBeNull();
      expect(security.noteFailure("192.0.2.1", "ada")).toMatchObject({
        ipAttemptsLeft: 6,
        panelAttemptsLeft: 8,
        block: { retryAfter: 60 },
      });
      security.resetFailures("192.0.2.1", "ada");
      expect(security.beforeAttempt("192.0.2.1", "ada")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("shows an IP ban alongside its cooldown and remaining panel attempts", () => {
    const db = openDatabase(":memory:");
    const security = createLoginSecurity({
      db,
      masterKey: randomBytes(32),
      now: () => 1_700_000_000_000,
    });
    try {
      security.update(
        {
          loginRestrictions: {
            banIp: { attempts: 3, duration: "permanent" },
            banPanel: { enabled: true, attempts: 5 },
          },
        },
        "ada",
      );
      security.noteFailure("192.0.2.1", "ada");
      security.noteFailure("192.0.2.1", "ada");
      const failed = security.noteFailure("192.0.2.1", "ada");
      expect(failed.block).toMatchObject({
        code: "E_IP_BANNED",
        panelAttemptsLeft: 2,
        restrictionWarnings: [{ code: "E_RATE_LIMITED", retryAfter: 30 }],
      });
      expect(failed.ipAttemptsLeft).toBeUndefined();
      expect(security.beforeAttempt("192.0.2.1", "ada")).toEqual(failed.block);
      security.update(
        { loginRestrictions: { banIp: { enabled: false }, banPanel: { enabled: false } } },
        "ada",
      );
      expect(security.beforeAttempt("192.0.2.1", "ada")).toEqual({
        code: "E_RATE_LIMITED",
        message: expect.any(String),
        retryAfter: 30,
      });
    } finally {
      db.close();
    }
  });

  it("reports all active restrictions and removes expired or disabled warnings", () => {
    let now = 1_700_000_000_000;
    const db = openDatabase(":memory:");
    const security = createLoginSecurity({ db, masterKey: randomBytes(32), now: () => now });
    try {
      security.update(
        {
          loginRestrictions: {
            banIp: { attempts: 3, seconds: 120 },
            banPanel: { enabled: true, attempts: 3, seconds: 90 },
          },
        },
        "ada",
      );
      security.noteFailure("192.0.2.1", "ada");
      security.noteFailure("192.0.2.1", "ada");
      const failed = security.noteFailure("192.0.2.1", "ada");
      expect(failed.block).toMatchObject({
        code: "E_PANEL_LOCKED",
        retryAfter: 90,
        restrictionWarnings: [
          { code: "E_IP_BANNED", retryAfter: 120 },
          { code: "E_RATE_LIMITED", retryAfter: 30 },
        ],
      });
      expect(security.beforeAttempt("192.0.2.1", "ada")).toEqual(failed.block);
      now += 31_000;
      expect(security.beforeAttempt("192.0.2.1", "ada")).toMatchObject({
        code: "E_PANEL_LOCKED",
        retryAfter: 59,
        restrictionWarnings: [{ code: "E_IP_BANNED", retryAfter: 89 }],
      });
      security.update({ loginRestrictions: { banPanel: { enabled: false } } }, "ada");
      expect(security.beforeAttempt("192.0.2.1", "ada")).toEqual({
        code: "E_IP_BANNED",
        message: expect.any(String),
        retryAfter: 89,
      });
      now += 90_000;
      expect(security.beforeAttempt("192.0.2.1", "ada")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("stores policy and encrypts the Turnstile secret", () => {
    const db = openDatabase(":memory:");
    const security = createLoginSecurity({ db, masterKey: randomBytes(32) });

    const view = security.update(
      {
        loginRestrictions: {
          rateLimit: { mode: "custom", attempts: 4, waitSec: 75 },
          banIp: { attempts: 6, duration: "permanent" },
        },
        turnstile: { enabled: true, siteKey: "site-key", secret: "secret-key" },
      },
      "ada",
    );

    expect(view.loginRestrictions.rateLimit).toMatchObject({
      mode: "custom",
      attempts: 4,
      waitSec: 75,
    });
    expect(view.turnstile).toEqual({
      enabled: true,
      siteKey: "site-key",
      secretConfigured: true,
    });
    expect(security.runtime().turnstile.secret).toBe("secret-key");
    const stored = db
      .prepare("SELECT value_json FROM settings WHERE key = 'security.turnstile.secret'")
      .get() as { value_json: string };
    expect(stored.value_json).not.toContain("secret-key");
    expect(() =>
      security.update({ loginRestrictions: { banPanel: { attempts: 2 } } }, "ada"),
    ).toThrow(LoginSecurityError);
  });

  it("uses the default progressive delay from 30 seconds up to one hour", () => {
    let now = 1_700_000_000_000;
    const db = openDatabase(":memory:");
    const security = createLoginSecurity({
      db,
      masterKey: randomBytes(32),
      now: () => now,
    });
    security.update({ loginRestrictions: { banIp: { enabled: false } } }, "ada");

    expect(security.noteFailure("192.0.2.1", "Ada").block).toBeUndefined();
    expect(security.noteFailure("192.0.2.1", "Ada").ipAttemptsLeft).toBeUndefined();
    expect(security.noteFailure("192.0.2.1", "Ada").block?.retryAfter).toBe(30);
    expect(security.beforeAttempt("192.0.2.1", "ada")?.retryAfter).toBe(30);
    now += 30_000;
    expect(security.beforeAttempt("192.0.2.1", "ada")).toBeNull();
    expect(security.noteFailure("192.0.2.1", "Ada").block?.retryAfter).toBe(60);

    for (let failures = 5; failures <= 12; failures += 1) {
      now += 3_600_000;
      security.noteFailure("192.0.2.1", "Ada");
    }
    expect(security.beforeAttempt("192.0.2.1", "ada")?.retryAfter).toBe(3_600);
  });

  it("bans one address, lists it, and removes it without affecting other addresses", () => {
    const db = openDatabase(":memory:");
    const security = createLoginSecurity({ db, masterKey: randomBytes(32) });
    security.update(
      {
        loginRestrictions: {
          rateLimit: { enabled: false },
          banIp: { enabled: true, attempts: 3, duration: "temporary", seconds: 90 },
        },
      },
      "ada",
    );

    security.noteFailure("192.0.2.8", "ada");
    expect(security.noteFailure("192.0.2.8", "ada").ipAttemptsLeft).toBe(1);
    expect(security.noteFailure("192.0.2.8", "ada").block?.code).toBe("E_IP_BANNED");
    expect(security.beforeAttempt("192.0.2.8", "ada")?.code).toBe("E_IP_BANNED");
    expect(security.beforeAttempt("192.0.2.9", "ada")).toBeNull();
    expect(security.bannedIps()).toHaveLength(1);
    expect(security.unbanIp("192.0.2.8")).toBe(true);
    expect(security.bannedIps()).toEqual([]);
    expect(security.beforeAttempt("192.0.2.8", "ada")).toBeNull();
  });

  it("keeps a permanent whole-panel lock until the SSH management action clears it", () => {
    const db = openDatabase(":memory:");
    const security = createLoginSecurity({ db, masterKey: randomBytes(32) });
    security.update(
      {
        loginRestrictions: {
          rateLimit: { enabled: false },
          banIp: { enabled: false },
          banPanel: { enabled: true, attempts: 3, duration: "permanent" },
        },
      },
      "ada",
    );

    security.noteFailure("192.0.2.1", "ada");
    expect(security.noteFailure("192.0.2.2", "ada").panelAttemptsLeft).toBe(1);
    expect(security.noteFailure("192.0.2.3", "ada").block?.code).toBe("E_PANEL_LOCKED");
    expect(security.beforeAttempt("192.0.2.99", "ada")?.message).toContain(
      "sudo unpanel-manage unlock",
    );
    expect(unlockPanelLock(db)).toBe(true);
    expect(security.beforeAttempt("192.0.2.99", "ada")).toBeNull();
  });
});
