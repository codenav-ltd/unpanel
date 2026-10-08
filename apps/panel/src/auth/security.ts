// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { DatabaseSync } from "node:sqlite";
import { decryptSecret, encryptSecret } from "./secret.ts";

const KEY_POLICY = "security.login";
const KEY_TURNSTILE_SECRET = "security.turnstile.secret";
const PANEL_KEY = "panel";
const MAX_ATTEMPTS = 100;
const MAX_SECONDS = 365 * 24 * 60 * 60;

export type RateLimitMode = "default" | "custom";
export type BanDurationMode = "temporary" | "permanent";

export interface LoginSecurityView {
  loginRestrictions: {
    enabled: boolean;
    rateLimit: {
      enabled: boolean;
      mode: RateLimitMode;
      attempts: number;
      waitSec: number;
    };
    banIp: {
      enabled: boolean;
      attempts: number;
      duration: BanDurationMode;
      seconds: number;
    };
    banPanel: {
      enabled: boolean;
      attempts: number;
      duration: BanDurationMode;
      seconds: number;
    };
  };
  turnstile: {
    enabled: boolean;
    siteKey: string;
    secretConfigured: boolean;
  };
}

export interface LoginSecurityRuntime extends LoginSecurityView {
  turnstile: LoginSecurityView["turnstile"] & { secret: string };
}

export interface LoginRestriction {
  code: "E_RATE_LIMITED" | "E_IP_BANNED" | "E_PANEL_LOCKED";
  message: string;
  retryAfter?: number;
}

export interface LoginBlock extends LoginRestriction {
  ipAttemptsLeft?: number;
  panelAttemptsLeft?: number;
  restrictionWarnings?: LoginRestriction[];
}

export interface LoginFailureState {
  block?: LoginBlock;
  ipAttemptsLeft?: number;
  panelAttemptsLeft?: number;
}

export interface BannedIp {
  ip: string;
  failures: number;
  createdAt: number;
  expiresAt: number | null;
}

export interface LoginSecurity {
  view: () => LoginSecurityView;
  runtime: () => LoginSecurityRuntime;
  update: (patch: unknown, updatedBy: string) => LoginSecurityView;
  beforeAttempt: (ip: string, username: string) => LoginBlock | null;
  noteFailure: (ip: string, username: string) => LoginFailureState;
  resetFailures: (ip: string, username: string) => void;
  bannedIps: () => BannedIp[];
  unbanIp: (ip: string) => boolean;
}

interface StoredPolicy {
  loginRestrictions: LoginSecurityView["loginRestrictions"];
  turnstile: Omit<LoginSecurityView["turnstile"], "secretConfigured">;
}

interface AttemptRow {
  failures: number;
  next_allowed_at: number | null;
}

interface BanRow {
  key: string;
  failures: number;
  created_at: number;
  expires_at: number | null;
}

export function defaultLoginSecurity(): LoginSecurityView {
  return {
    loginRestrictions: {
      enabled: true,
      rateLimit: { enabled: true, mode: "default", attempts: 3, waitSec: 30 },
      banIp: { enabled: true, attempts: 10, duration: "temporary", seconds: 15 * 60 },
      banPanel: { enabled: false, attempts: 10, duration: "temporary", seconds: 15 * 60 },
    },
    turnstile: { enabled: false, siteKey: "", secretConfigured: false },
  };
}

export function createLoginSecurity(options: {
  db: DatabaseSync;
  masterKey: Buffer;
  now?: () => number;
}): LoginSecurity {
  const { db } = options;
  const seconds = (): number => Math.floor((options.now ?? Date.now)() / 1000);
  ensureSecurityTables(db);

  function read(key: string): unknown {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
      { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json) as unknown;
    } catch {
      return undefined;
    }
  }

  function write(key: string, value: unknown, updatedBy: string): void {
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    ).run(key, JSON.stringify(value), (options.now ?? Date.now)(), updatedBy);
  }

  function stored(): StoredPolicy {
    return policyFromStored(read(KEY_POLICY));
  }

  function hasSecret(): boolean {
    return typeof read(KEY_TURNSTILE_SECRET) === "string";
  }

  function view(): LoginSecurityView {
    const policy = stored();
    return {
      loginRestrictions: policy.loginRestrictions,
      turnstile: { ...policy.turnstile, secretConfigured: hasSecret() },
    };
  }

  function runtime(): LoginSecurityRuntime {
    const publicView = view();
    const encoded = read(KEY_TURNSTILE_SECRET);
    let secret = "";
    if (typeof encoded === "string") {
      secret = Buffer.from(decryptSecret(encoded, options.masterKey)).toString("utf8");
    }
    return { ...publicView, turnstile: { ...publicView.turnstile, secret } };
  }

  function update(patch: unknown, updatedBy: string): LoginSecurityView {
    const input = record(patch, "Security settings must be an object.");
    const next = stored();
    const login = optionalRecord(input, "loginRestrictions");
    if (login) {
      assignBoolean(login, "enabled", (value) => (next.loginRestrictions.enabled = value));
      const rate = optionalRecord(login, "rateLimit");
      if (rate) {
        assignBoolean(
          rate,
          "enabled",
          (value) => (next.loginRestrictions.rateLimit.enabled = value),
        );
        assignChoice(rate, "mode", ["default", "custom"] as const, (value) => {
          next.loginRestrictions.rateLimit.mode = value;
        });
        assignInteger(rate, "attempts", 3, MAX_ATTEMPTS, (value) => {
          next.loginRestrictions.rateLimit.attempts = value;
        });
        assignInteger(rate, "waitSec", 1, MAX_SECONDS, (value) => {
          next.loginRestrictions.rateLimit.waitSec = value;
        });
      }
      applyBan(optionalRecord(login, "banIp"), next.loginRestrictions.banIp, "IP ban");
      applyBan(optionalRecord(login, "banPanel"), next.loginRestrictions.banPanel, "Panel lock");
    }

    const turnstile = optionalRecord(input, "turnstile");
    let nextSecret: string | null | undefined;
    if (turnstile) {
      assignBoolean(turnstile, "enabled", (value) => (next.turnstile.enabled = value));
      if ("siteKey" in turnstile) {
        if (typeof turnstile["siteKey"] !== "string") {
          throw new LoginSecurityError("Turnstile site key must be text. Nothing was saved.");
        }
        const siteKey = turnstile["siteKey"].trim();
        if (siteKey.length > 200) {
          throw new LoginSecurityError(
            "Turnstile site key must be 200 characters or fewer. Nothing was saved.",
          );
        }
        next.turnstile.siteKey = siteKey;
      }
      if ("secret" in turnstile) {
        if (typeof turnstile["secret"] !== "string") {
          throw new LoginSecurityError("Turnstile secret key must be text. Nothing was saved.");
        }
        const secret = turnstile["secret"].trim();
        if (secret.length > 500) {
          throw new LoginSecurityError(
            "Turnstile secret key must be 500 characters or fewer. Nothing was saved.",
          );
        }
        if (secret) nextSecret = secret;
      }
      if (turnstile["clearSecret"] === true) nextSecret = null;
      if ("clearSecret" in turnstile && typeof turnstile["clearSecret"] !== "boolean") {
        throw new LoginSecurityError("Clear secret must be on or off. Nothing was saved.");
      }
    }

    const secretWillExist = nextSecret === undefined ? hasSecret() : nextSecret !== null;
    if (next.turnstile.enabled && (!next.turnstile.siteKey || !secretWillExist)) {
      throw new LoginSecurityError(
        "Add both Turnstile keys before enabling verification. Nothing was saved.",
      );
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      write(KEY_POLICY, next, updatedBy);
      if (typeof nextSecret === "string") {
        write(
          KEY_TURNSTILE_SECRET,
          encryptSecret(Buffer.from(nextSecret, "utf8"), options.masterKey),
          updatedBy,
        );
      } else if (nextSecret === null) {
        db.prepare("DELETE FROM settings WHERE key = ?").run(KEY_TURNSTILE_SECRET);
      }
      reconcileDisabled(next.loginRestrictions);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return view();
  }

  function reconcileDisabled(policy: StoredPolicy["loginRestrictions"]): void {
    if (!policy.enabled) {
      db.exec("DELETE FROM auth_attempts; DELETE FROM auth_bans;");
      return;
    }
    if (!policy.rateLimit.enabled) {
      db.prepare("DELETE FROM auth_attempts WHERE scope = 'user'").run();
    }
    if (!policy.banIp.enabled) {
      db.prepare("DELETE FROM auth_attempts WHERE scope = 'ip'").run();
      db.prepare("DELETE FROM auth_bans WHERE kind = 'ip'").run();
    }
    if (!policy.banPanel.enabled) {
      db.prepare("DELETE FROM auth_attempts WHERE scope = 'panel'").run();
      db.prepare("DELETE FROM auth_bans WHERE kind = 'panel'").run();
    }
  }

  function beforeAttempt(ip: string, username: string): LoginBlock | null {
    const policy = stored().loginRestrictions;
    if (!policy.enabled) return null;
    const now = seconds();
    cleanupExpired(now);
    const blocks: LoginRestriction[] = [];
    if (policy.banPanel.enabled) {
      const ban = banRow("panel", PANEL_KEY);
      if (ban) blocks.push(panelBlock(ban, now));
    }
    if (policy.banIp.enabled) {
      const ban = banRow("ip", ip);
      if (ban) blocks.push(ipBlock(ban, now));
    }
    if (policy.rateLimit.enabled) {
      const row = attemptRow("user", normalizeUsername(username));
      const wait = Number(row?.next_allowed_at ?? 0) - now;
      if (wait > 0) blocks.push(rateBlock(wait));
    }
    if (!blocks.length) return null;
    return combineBlocks(
      blocks,
      attemptWarnings(
        policy,
        Number(attemptRow("ip", ip)?.failures ?? 0),
        Number(attemptRow("panel", PANEL_KEY)?.failures ?? 0),
      ),
    );
  }

  function noteFailure(ip: string, username: string): LoginFailureState {
    const policy = stored().loginRestrictions;
    if (!policy.enabled) return {};
    const now = seconds();
    let rateWait = 0;
    let ipFailures = 0;
    let panelFailures = 0;
    let ipBan: BanRow | null = null;
    let panelBan: BanRow | null = null;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (policy.rateLimit.enabled) {
        const rateFailures = incrementAttempt("user", normalizeUsername(username), now, null);
        rateWait = rateDelay(policy.rateLimit, rateFailures);
        if (rateWait > 0) setNextAllowed("user", normalizeUsername(username), now + rateWait);
      }
      if (policy.banIp.enabled) {
        ipFailures = incrementAttempt("ip", ip, now, null);
        if (ipFailures >= policy.banIp.attempts) {
          ipBan = setBan("ip", ip, ipFailures, policy.banIp.duration, policy.banIp.seconds, now);
        }
      }
      if (policy.banPanel.enabled) {
        panelFailures = incrementAttempt("panel", PANEL_KEY, now, null);
        if (panelFailures >= policy.banPanel.attempts) {
          panelBan = setBan(
            "panel",
            PANEL_KEY,
            panelFailures,
            policy.banPanel.duration,
            policy.banPanel.seconds,
            now,
          );
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const warnings = attemptWarnings(policy, ipFailures, panelFailures);
    const blocks: LoginRestriction[] = [];
    if (panelBan) blocks.push(panelBlock(panelBan, now));
    if (ipBan) blocks.push(ipBlock(ipBan, now));
    if (rateWait > 0) blocks.push(rateBlock(rateWait));
    const block = combineBlocks(blocks, warnings);
    return { ...warnings, ...(block ? { block } : {}) };
  }

  function resetFailures(ip: string, username: string): void {
    const policy = stored().loginRestrictions;
    if (!policy.enabled) return;
    db.prepare(
      `DELETE FROM auth_attempts
       WHERE (scope = 'user' AND key = ?)
          OR (scope = 'ip' AND key = ?)
          OR (scope = 'panel' AND key = ?)`,
    ).run(normalizeUsername(username), ip, PANEL_KEY);
  }

  function cleanupExpired(now: number): void {
    const expired = db
      .prepare("SELECT kind, key FROM auth_bans WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .all(now) as { kind: "ip" | "panel"; key: string }[];
    for (const row of expired) {
      db.prepare("DELETE FROM auth_attempts WHERE scope = ? AND key = ?").run(row.kind, row.key);
    }
    db.prepare("DELETE FROM auth_bans WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
  }

  function bannedIps(): BannedIp[] {
    cleanupExpired(seconds());
    return (
      db
        .prepare(
          `SELECT key, failures, created_at, expires_at
         FROM auth_bans WHERE kind = 'ip' ORDER BY created_at DESC, key ASC`,
        )
        .all() as unknown as BanRow[]
    ).map((row) => ({
      ip: row.key,
      failures: Number(row.failures),
      createdAt: Number(row.created_at),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    }));
  }

  function unbanIp(ip: string): boolean {
    const address = ip.trim();
    if (!address || address.length > 64) return false;
    const result = db.prepare("DELETE FROM auth_bans WHERE kind = 'ip' AND key = ?").run(address);
    db.prepare("DELETE FROM auth_attempts WHERE scope = 'ip' AND key = ?").run(address);
    return Number(result.changes) > 0;
  }

  return { view, runtime, update, beforeAttempt, noteFailure, resetFailures, bannedIps, unbanIp };

  function attemptRow(scope: string, key: string): AttemptRow | undefined {
    return db
      .prepare("SELECT failures, next_allowed_at FROM auth_attempts WHERE scope = ? AND key = ?")
      .get(scope, key) as AttemptRow | undefined;
  }

  function incrementAttempt(
    scope: "user" | "ip" | "panel",
    key: string,
    now: number,
    nextAllowed: number | null,
  ): number {
    db.prepare(
      `INSERT INTO auth_attempts (scope, key, failures, last_failed_at, next_allowed_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT (scope, key) DO UPDATE SET
         failures = auth_attempts.failures + 1,
         last_failed_at = excluded.last_failed_at,
         next_allowed_at = excluded.next_allowed_at`,
    ).run(scope, key, now, nextAllowed);
    return Number(attemptRow(scope, key)?.failures ?? 1);
  }

  function setNextAllowed(scope: string, key: string, at: number): void {
    db.prepare("UPDATE auth_attempts SET next_allowed_at = ? WHERE scope = ? AND key = ?").run(
      at,
      scope,
      key,
    );
  }

  function setBan(
    kind: "ip" | "panel",
    key: string,
    failures: number,
    duration: BanDurationMode,
    durationSec: number,
    now: number,
  ): BanRow {
    const expiresAt = duration === "permanent" ? null : now + durationSec;
    db.prepare(
      `INSERT INTO auth_bans (kind, key, failures, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (kind, key) DO UPDATE SET
         failures = excluded.failures,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`,
    ).run(kind, key, failures, now, expiresAt);
    return { key, failures, created_at: now, expires_at: expiresAt };
  }

  function banRow(kind: "ip" | "panel", key: string): BanRow | undefined {
    return db
      .prepare(
        "SELECT key, failures, created_at, expires_at FROM auth_bans WHERE kind = ? AND key = ?",
      )
      .get(kind, key) as BanRow | undefined;
  }
}

export class LoginSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginSecurityError";
  }
}

export function ensureSecurityTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_attempts (
      scope TEXT NOT NULL CHECK (scope IN ('user', 'ip', 'panel')),
      key TEXT NOT NULL,
      failures INTEGER NOT NULL,
      last_failed_at INTEGER NOT NULL,
      next_allowed_at INTEGER,
      PRIMARY KEY (scope, key)
    );
    CREATE TABLE IF NOT EXISTS auth_bans (
      kind TEXT NOT NULL CHECK (kind IN ('ip', 'panel')),
      key TEXT NOT NULL,
      failures INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (kind, key)
    );
    CREATE INDEX IF NOT EXISTS auth_bans_expiry ON auth_bans(expires_at);
  `);
}

export function unlockPanelLock(db: DatabaseSync): boolean {
  ensureSecurityTables(db);
  const result = db
    .prepare("DELETE FROM auth_bans WHERE kind = 'panel' AND key = ?")
    .run(PANEL_KEY);
  db.prepare("DELETE FROM auth_attempts WHERE scope = 'panel' AND key = ?").run(PANEL_KEY);
  return Number(result.changes) > 0;
}

function policyFromStored(value: unknown): StoredPolicy {
  const defaults = defaultLoginSecurity();
  if (!isRecord(value)) {
    return {
      loginRestrictions: defaults.loginRestrictions,
      turnstile: { enabled: defaults.turnstile.enabled, siteKey: defaults.turnstile.siteKey },
    };
  }
  try {
    const login = record(value["loginRestrictions"], "");
    const rate = record(login["rateLimit"], "");
    const banIp = record(login["banIp"], "");
    const banPanel = record(login["banPanel"], "");
    const turnstile = record(value["turnstile"], "");
    return {
      loginRestrictions: {
        enabled: boolean(login["enabled"]),
        rateLimit: {
          enabled: boolean(rate["enabled"]),
          mode: choice(rate["mode"], ["default", "custom"] as const),
          attempts: integer(rate["attempts"], 3, MAX_ATTEMPTS),
          waitSec: integer(rate["waitSec"], 1, MAX_SECONDS),
        },
        banIp: storedBan(banIp),
        banPanel: storedBan(banPanel),
      },
      turnstile: {
        enabled: boolean(turnstile["enabled"]),
        siteKey: text(turnstile["siteKey"], 200),
      },
    };
  } catch {
    return {
      loginRestrictions: defaults.loginRestrictions,
      turnstile: { enabled: defaults.turnstile.enabled, siteKey: defaults.turnstile.siteKey },
    };
  }
}

function storedBan(value: Record<string, unknown>): StoredPolicy["loginRestrictions"]["banIp"] {
  return {
    enabled: boolean(value["enabled"]),
    attempts: integer(value["attempts"], 3, MAX_ATTEMPTS),
    duration: choice(value["duration"], ["temporary", "permanent"] as const),
    seconds: integer(value["seconds"], 1, MAX_SECONDS),
  };
}

function applyBan(
  patch: Record<string, unknown> | null,
  target: StoredPolicy["loginRestrictions"]["banIp"],
  label: string,
): void {
  if (!patch) return;
  assignBoolean(patch, "enabled", (value) => (target.enabled = value));
  assignInteger(patch, "attempts", 3, MAX_ATTEMPTS, (value) => (target.attempts = value), label);
  assignChoice(patch, "duration", ["temporary", "permanent"] as const, (value) => {
    target.duration = value;
  });
  assignInteger(patch, "seconds", 1, MAX_SECONDS, (value) => (target.seconds = value), label);
}

function attemptWarnings(
  policy: StoredPolicy["loginRestrictions"],
  ipFailures: number,
  panelFailures: number,
): LoginFailureState {
  const result: LoginFailureState = {};
  if (policy.banIp.enabled && ipFailures >= 2 && ipFailures < policy.banIp.attempts) {
    result.ipAttemptsLeft = policy.banIp.attempts - ipFailures;
  }
  if (policy.banPanel.enabled && panelFailures >= 2 && panelFailures < policy.banPanel.attempts) {
    result.panelAttemptsLeft = policy.banPanel.attempts - panelFailures;
  }
  return result;
}

function rateDelay(
  policy: StoredPolicy["loginRestrictions"]["rateLimit"],
  failures: number,
): number {
  if (policy.mode === "custom") return failures >= policy.attempts ? policy.waitSec : 0;
  if (failures < 3) return 0;
  return Math.min(60 * 60, 30 * 2 ** (failures - 3));
}

function rateBlock(wait: number): LoginRestriction {
  return {
    code: "E_RATE_LIMITED",
    message: "Too many failed sign-in attempts. Wait before trying again.",
    retryAfter: wait,
  };
}

function combineBlocks(
  blocks: LoginRestriction[],
  warnings: Pick<LoginFailureState, "ipAttemptsLeft" | "panelAttemptsLeft">,
): LoginBlock | null {
  const first = blocks[0];
  if (!first) return null;
  return {
    ...first,
    ...warnings,
    ...(blocks.length > 1 ? { restrictionWarnings: blocks.slice(1) } : {}),
  };
}

function panelBlock(row: BanRow, now: number): LoginBlock {
  const retryAfter = row.expires_at === null ? undefined : Math.max(1, row.expires_at - now);
  return {
    code: "E_PANEL_LOCKED",
    message:
      row.expires_at === null
        ? "This panel is locked after too many failed sign-in attempts. Connect over SSH and run sudo unpanel-manage unlock."
        : "This panel is temporarily locked after too many failed sign-in attempts.",
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}

function ipBlock(row: BanRow, now: number): LoginBlock {
  const retryAfter = row.expires_at === null ? undefined : Math.max(1, row.expires_at - now);
  return {
    code: "E_IP_BANNED",
    message:
      row.expires_at === null
        ? "This address is blocked from signing in. An administrator must remove the block."
        : "This address is temporarily blocked after too many failed sign-in attempts.",
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase().slice(0, 128);
}

function optionalRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  if (!(key in value)) return null;
  return record(value[key], `${key} must be an object. Nothing was saved.`);
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new LoginSecurityError(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assignBoolean(
  value: Record<string, unknown>,
  key: string,
  assign: (next: boolean) => void,
): void {
  if (!(key in value)) return;
  if (typeof value[key] !== "boolean") {
    throw new LoginSecurityError(`${key} must be on or off. Nothing was saved.`);
  }
  assign(value[key]);
}

function assignInteger(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  assign: (next: number) => void,
  label = key,
): void {
  if (!(key in value)) return;
  const next = value[key];
  if (typeof next !== "number" || !Number.isInteger(next) || next < min || next > max) {
    throw new LoginSecurityError(
      `${label} ${key} must be a whole number from ${min} to ${max}. Nothing was saved.`,
    );
  }
  assign(next);
}

function assignChoice<T extends string>(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  assign: (next: T) => void,
): void {
  if (!(key in value)) return;
  try {
    assign(choice(value[key], allowed));
  } catch {
    throw new LoginSecurityError(`${key} must be ${allowed.join(" or ")}. Nothing was saved.`);
  }
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("invalid boolean");
  return value;
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error("invalid integer");
  }
  return value;
}

function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error("invalid choice");
  return value as T;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new Error("invalid text");
  return value;
}
