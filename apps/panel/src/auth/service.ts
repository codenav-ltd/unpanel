// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { decryptSecret, encryptSecret } from "./secret.ts";
import { hashPassword, passwordProblem, usernameProblem, verifyPassword } from "./password.ts";
import type { LoginBlock, LoginSecurity } from "./security.ts";
import { matchTotp, totpSecret, totpSecretText, totpUri } from "./totp.ts";
import {
  TurnstileUnavailableError,
  verifyTurnstileToken,
  type TurnstileVerifier,
} from "./turnstile.ts";

const IDLE_SEC = 12 * 60 * 60;
const ABSOLUTE_SEC = 7 * 24 * 60 * 60;
const SEEN_THROTTLE_SEC = 5 * 60;
const TICKET_SEC = 5 * 60;
const SETUP_SEC = 10 * 60;
const MAX_ATTEMPTS = 5;

export interface AuthFailure {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 429 | 503;
  code: string;
  message: string;
  retryAfter?: number;
  ipAttemptsLeft?: number;
  panelAttemptsLeft?: number;
}

export interface SessionUser {
  id: string;
  username: string;
}

interface PendingSetup {
  username: string;
  passwordHash: string;
  secret: Uint8Array;
  recoveryHashes: string[];
  expiresAt: number;
  attempts: number;
}

export interface Auth {
  initialized: () => boolean;
  beginSetup: (input: { token: string; username: string; password: string }) => Promise<
    | {
        ok: true;
        ticket: string;
        secret: string;
        otpauthUri: string;
        recoveryCodes: string[];
      }
    | AuthFailure
  >;
  confirmSetup: (input: {
    ticket: string;
    totp: boolean;
    code: string;
    recoveryCode: string;
    ip: string;
    userAgent: string;
  }) => { ok: true; token: string } | AuthFailure;
  login: (input: {
    username: string;
    password: string;
    turnstileToken: string;
    ip: string;
    userAgent: string;
  }) => Promise<
    | { ok: true; status: "mfa_required"; ticket: string }
    | { ok: true; status: "ok"; token: string }
    | AuthFailure
  >;
  confirmTotp: (input: {
    ticket: string;
    code: string;
    ip: string;
    userAgent: string;
  }) => { ok: true; token: string } | AuthFailure;
  logout: (token: string | null) => void;
  sessionUser: (token: string | null) => SessionUser | null;
  changePassword: (input: {
    userId: string;
    current: string;
    next: string;
  }) => Promise<{ ok: true } | AuthFailure>;
  close: () => void;
}

export async function createAuth(options: {
  db: DatabaseSync;
  masterKey: Buffer;
  setupToken: () => string | null;
  clearSetupToken: () => void;
  security: LoginSecurity;
  verifyTurnstile?: TurnstileVerifier;
  now?: () => number;
}): Promise<Auth> {
  const nowMs = options.now ?? Date.now;
  const seconds = (): number => Math.floor(nowMs() / 1000);
  const setups = new Map<string, PendingSetup>();
  const dummy = await hashPassword(randomBytes(32).toString("base64url"));
  const verifyTurnstile = options.verifyTurnstile ?? verifyTurnstileToken;

  function userCount(): number {
    const row = options.db.prepare("SELECT COUNT(*) AS n FROM users").get() as
      { n: number | bigint } | undefined;
    return Number(row?.n ?? 0);
  }

  function issueSession(
    userId: string,
    ip: string,
    userAgent: string,
    method: "password" | "password+totp",
  ): string {
    const token = randomBytes(32).toString("base64url");
    const now = seconds();
    options.db
      .prepare(
        `INSERT INTO sessions (
          id, user_id, auth_method, elevated_until, ip, user_agent,
          created_at, last_seen_at, idle_expires_at, absolute_expires_at
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha256(token),
        userId,
        method,
        ip.slice(0, 64),
        userAgent.slice(0, 256),
        now,
        now,
        now + IDLE_SEC,
        now + ABSOLUTE_SEC,
      );
    options.db
      .prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, userId);
    return token;
  }

  return {
    initialized: () => userCount() > 0,

    async beginSetup(input) {
      if (userCount() > 0 || options.setupToken() === null) {
        return {
          ok: false,
          status: 404,
          code: "E_NOT_FOUND",
          message: "Setup is already complete.",
        };
      }
      const expected = options.setupToken();
      if (expected === null || !fixedEqual(expected, input.token)) {
        return {
          ok: false,
          status: 401,
          code: "E_UNAUTHENTICATED",
          message: "Invalid setup token.",
        };
      }
      const usernameError = usernameProblem(input.username);
      if (usernameError)
        return { ok: false, status: 400, code: "E_INVALID_PARAMS", message: usernameError };
      const passwordError = passwordProblem(input.password, input.username);
      if (passwordError)
        return { ok: false, status: 400, code: "E_INVALID_PARAMS", message: passwordError };

      const secret = totpSecret();
      const recoveryCodes = createRecoveryCodes();
      const ticket = randomBytes(32).toString("base64url");
      setups.set(sha256(ticket), {
        username: input.username,
        passwordHash: await hashPassword(input.password),
        secret,
        recoveryHashes: recoveryCodes.map(hashRecovery),
        expiresAt: seconds() + SETUP_SEC,
        attempts: 0,
      });
      return {
        ok: true,
        ticket,
        secret: totpSecretText(secret),
        otpauthUri: totpUri(input.username, secret),
        recoveryCodes,
      };
    },

    confirmSetup(input) {
      const pending = setups.get(sha256(input.ticket));
      if (!pending || pending.expiresAt <= seconds()) {
        if (pending) setups.delete(sha256(input.ticket));
        return {
          ok: false,
          status: 401,
          code: "E_UNAUTHENTICATED",
          message: "This setup session expired. Start again.",
        };
      }
      pending.attempts += 1;
      if (pending.attempts > MAX_ATTEMPTS) {
        setups.delete(sha256(input.ticket));
        return {
          ok: false,
          status: 401,
          code: "E_UNAUTHENTICATED",
          message: "Too many attempts. Start setup again.",
        };
      }
      const step = input.totp ? matchTotp(pending.secret, input.code, nowMs(), null) : null;
      const recoveryOk =
        !input.totp || pending.recoveryHashes.includes(hashRecovery(input.recoveryCode));
      if (input.totp && step === null) {
        return {
          ok: false,
          status: 401,
          code: "E_UNAUTHENTICATED",
          message: "That authenticator code is not valid.",
        };
      }
      if (input.totp && !recoveryOk) {
        return {
          ok: false,
          status: 401,
          code: "E_UNAUTHENTICATED",
          message: "That recovery code is not one of the ten just shown.",
        };
      }
      const now = seconds();
      const userId = randomBytes(16).toString("base64url");
      const db = options.db;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (userCount() > 0) {
          db.exec("ROLLBACK");
          setups.delete(sha256(input.ticket));
          return {
            ok: false,
            status: 404,
            code: "E_NOT_FOUND",
            message: "Setup is already complete.",
          };
        }
        db.prepare(
          `INSERT INTO users (
            id, username, password_hash, totp_secret_enc, totp_last_step, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        ).run(
          userId,
          pending.username,
          pending.passwordHash,
          input.totp ? encryptSecret(pending.secret, options.masterKey) : null,
          input.totp ? step : null,
          now,
          now,
        );
        if (input.totp) {
          const insertCode = db.prepare(
            "INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)",
          );
          for (const codeHash of pending.recoveryHashes) {
            insertCode.run(randomBytes(16).toString("base64url"), userId, codeHash, now);
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        if (isUnique(error)) {
          return {
            ok: false,
            status: 409,
            code: "E_CONFLICT",
            message: "That username is already in use.",
          };
        }
        throw error;
      }
      setups.delete(sha256(input.ticket));
      options.clearSetupToken();
      return {
        ok: true,
        token: issueSession(
          userId,
          input.ip,
          input.userAgent,
          input.totp ? "password+totp" : "password",
        ),
      };
    },

    async login(input) {
      const blocked = options.security.beforeAttempt(input.ip, input.username);
      if (blocked) return blockFailure(blocked);
      let security: ReturnType<LoginSecurity["runtime"]>;
      try {
        security = options.security.runtime();
      } catch {
        return {
          ok: false,
          status: 503,
          code: "E_SECURITY_CONFIG",
          message:
            "Login security settings could not be read. Sign in is paused to protect the panel. Check the panel logs over SSH.",
        };
      }
      if (security.turnstile.enabled) {
        if (!input.turnstileToken) {
          return {
            ok: false,
            status: 403,
            code: "E_TURNSTILE_REQUIRED",
            message: "Complete the security check before signing in.",
          };
        }
        let verified: boolean;
        try {
          verified = await verifyTurnstile({
            secret: security.turnstile.secret,
            token: input.turnstileToken,
            ip: input.ip,
          });
        } catch (error) {
          if (!(error instanceof TurnstileUnavailableError)) throw error;
          return {
            ok: false,
            status: 503,
            code: "E_TURNSTILE_UNAVAILABLE",
            message: "The security check could not be verified. Wait a moment and try again.",
          };
        }
        if (!verified) {
          return {
            ok: false,
            status: 403,
            code: "E_TURNSTILE_FAILED",
            message: "The security check failed or expired. Complete it again.",
          };
        }
      }
      const row = one<{
        id: string;
        password_hash: string | null;
        totp_secret_enc: string | null;
        status: string;
      }>(
        options.db,
        "SELECT id, password_hash, totp_secret_enc, status FROM users WHERE username = ? COLLATE NOCASE",
        input.username,
      );
      const hash = row?.password_hash ?? dummy;
      const valid = await verifyPassword(hash, input.password);
      if (!row || !row.password_hash || row.status !== "active" || !valid) {
        const failure = options.security.noteFailure(input.ip, input.username);
        if (failure.block) {
          return {
            ...blockFailure(failure.block),
            ...(failure.ipAttemptsLeft === undefined
              ? {}
              : { ipAttemptsLeft: failure.ipAttemptsLeft }),
            ...(failure.panelAttemptsLeft === undefined
              ? {}
              : { panelAttemptsLeft: failure.panelAttemptsLeft }),
          };
        }
        return {
          ok: false,
          status: 401,
          code: "E_UNAUTHENTICATED",
          message: "Invalid username or password.",
          ...(failure.ipAttemptsLeft === undefined
            ? {}
            : { ipAttemptsLeft: failure.ipAttemptsLeft }),
          ...(failure.panelAttemptsLeft === undefined
            ? {}
            : { panelAttemptsLeft: failure.panelAttemptsLeft }),
        };
      }
      options.security.resetFailures(input.ip, input.username);
      if (!row.totp_secret_enc) {
        return {
          ok: true,
          status: "ok",
          token: issueSession(row.id, input.ip, input.userAgent, "password"),
        };
      }
      const ticket = randomBytes(32).toString("base64url");
      options.db
        .prepare(
          "INSERT INTO pending_logins (id, user_id, attempts, expires_at) VALUES (?, ?, 0, ?)",
        )
        .run(sha256(ticket), row.id, seconds() + TICKET_SEC);
      return { ok: true, status: "mfa_required", ticket };
    },

    confirmTotp(input) {
      const id = sha256(input.ticket);
      const pending = one<{ user_id: string; attempts: number; expires_at: number }>(
        options.db,
        "SELECT user_id, attempts, expires_at FROM pending_logins WHERE id = ?",
        id,
      );
      if (!pending || pending.expires_at <= seconds()) {
        options.db.prepare("DELETE FROM pending_logins WHERE id = ?").run(id);
        return {
          ok: false,
          status: 401,
          code: "E_UNAUTHENTICATED",
          message: "This sign-in expired. Start again.",
        };
      }
      const attempts = pending.attempts + 1;
      if (attempts > MAX_ATTEMPTS) {
        options.db.prepare("DELETE FROM pending_logins WHERE id = ?").run(id);
        return {
          ok: false,
          status: 401,
          code: "E_UNAUTHENTICATED",
          message: "Too many attempts. Start sign-in again.",
        };
      }
      options.db.prepare("UPDATE pending_logins SET attempts = ? WHERE id = ?").run(attempts, id);
      const user = one<{ totp_secret_enc: string | null; totp_last_step: number | null }>(
        options.db,
        "SELECT totp_secret_enc, totp_last_step FROM users WHERE id = ?",
        pending.user_id,
      );
      const secret = user?.totp_secret_enc
        ? decryptSecret(user.totp_secret_enc, options.masterKey)
        : null;
      const storedStep = user?.totp_last_step;
      const lastStep = storedStep === null || storedStep === undefined ? null : Number(storedStep);
      const step = secret ? matchTotp(secret, input.code, nowMs(), lastStep) : null;
      if (step === null) {
        return { ok: false, status: 401, code: "E_UNAUTHENTICATED", message: "Invalid code." };
      }
      options.db
        .prepare("UPDATE users SET totp_last_step = ?, updated_at = ? WHERE id = ?")
        .run(step, seconds(), pending.user_id);
      options.db.prepare("DELETE FROM pending_logins WHERE id = ?").run(id);
      return {
        ok: true,
        token: issueSession(pending.user_id, input.ip, input.userAgent, "password+totp"),
      };
    },

    logout(token) {
      if (!token) return;
      options.db.prepare("DELETE FROM sessions WHERE id = ?").run(sha256(token));
    },

    async changePassword(input) {
      const row = one<{ username: string; password_hash: string | null }>(
        options.db,
        "SELECT username, password_hash FROM users WHERE id = ?",
        input.userId,
      );
      if (!row?.password_hash) {
        return { ok: false, status: 404, code: "E_NOT_FOUND", message: "Account not found." };
      }
      if (!(await verifyPassword(row.password_hash, input.current))) {
        return {
          ok: false,
          status: 401,
          code: "E_UNAUTHENTICATED",
          message: "Current password is wrong.",
        };
      }
      const problem = passwordProblem(input.next, row.username);
      if (problem) return { ok: false, status: 400, code: "E_INVALID_PARAMS", message: problem };
      options.db
        .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(await hashPassword(input.next), seconds(), input.userId);
      return { ok: true };
    },

    sessionUser(token) {
      if (!token) return null;
      const id = sha256(token);
      const row = one<{
        user_id: string;
        username: string;
        last_seen_at: number;
        idle_expires_at: number;
        absolute_expires_at: number;
      }>(
        options.db,
        `SELECT s.user_id, u.username, s.last_seen_at, s.idle_expires_at, s.absolute_expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND u.status = 'active'`,
        id,
      );
      if (!row) return null;
      const now = seconds();
      const idleExpires = Number(row.idle_expires_at);
      const absoluteExpires = Number(row.absolute_expires_at);
      const lastSeen = Number(row.last_seen_at);
      if (idleExpires <= now || absoluteExpires <= now) {
        options.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
        return null;
      }
      if (now - lastSeen >= SEEN_THROTTLE_SEC) {
        const idle = Math.min(now + IDLE_SEC, absoluteExpires);
        options.db
          .prepare("UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?")
          .run(now, idle, id);
      }
      return { id: row.user_id, username: row.username };
    },

    close() {
      options.db.close();
    },
  };
}

function blockFailure(block: LoginBlock): AuthFailure {
  return {
    ok: false,
    status: 429,
    code: block.code,
    message: block.message,
    ...(block.retryAfter === undefined ? {} : { retryAfter: block.retryAfter }),
  };
}

function one<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | undefined {
  const row = db.prepare(sql).get(...params);
  if (!row) return undefined;
  return row as T;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixedEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

const recoveryAlphabet = "abcdefghijkmnpqrstuvwxyz23456789";

function createRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const bytes = randomBytes(8);
    let text = "";
    for (const byte of bytes) text += recoveryAlphabet[byte % recoveryAlphabet.length];
    codes.push(`${text.slice(0, 4)}-${text.slice(4)}`);
  }
  return codes;
}

function hashRecovery(code: string): string {
  const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, "");
  return createHash("sha256").update(normalized).digest("hex");
}

function isUnique(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE");
}
