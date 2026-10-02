// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import type { AccountSecurityView, FactorKind, FactorPolicy, FactorView } from "@unpanel/shared";
import { product } from "@unpanel/shared";
import { decryptSecret, encryptSecret } from "./secret.ts";
import { matchTotp, totpSecret, totpSecretText, totpUri } from "./totp.ts";
import { verifyPassword } from "./password.ts";
import { AccountError } from "./account-error.ts";
import { emailAddress, type EmailMethods } from "../email/store.ts";

interface FactorData {
  secret?: string;
  address?: string;
  deliveryId?: string;
  credentialId?: string;
  publicKey?: string;
  counter?: number;
  transports?: string[];
  origin?: string;
  rpID?: string;
}
interface FactorRow {
  id: string;
  user_id: string;
  kind: FactorKind;
  name: string;
  data: string;
  last_step: number | null;
  created_at: number;
  last_used_at: number | null;
}
interface RequestRow {
  id: string;
  user_id: string;
  session_id: string;
  purpose: string;
  data: string;
  expires_at: number;
  attempts: number;
}
interface Enrollment extends FactorData {
  kind: FactorKind;
  name: string;
  challenge?: string;
  codeHash?: string;
}
const kinds: FactorKind[] = ["totp", "passkey", "email"];
// Older binaries must not interpret a migrated account as password-only.
const LEGACY_MFA_GUARD = "managed-by-mfa-v2";
function present<T>(value: T | null | undefined): T {
  if (value === undefined || value === null || value === "")
    throw new AccountError(
      "This stored credential is incomplete. Use another authentication method.",
      503,
    );
  return value;
}
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const recoveryHash = (value: string): string =>
  digest(value.toLowerCase().replace(/[^a-z0-9]/g, ""));
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string => (typeof value === "string" ? value : "");
function nameOf(value: unknown): string {
  const name = text(value).trim();
  if (!name || name.length > 80)
    throw new AccountError("Use a method name between 1 and 80 characters.");
  return name;
}

export function createFactors(options: {
  db: DatabaseSync;
  masterKey: Buffer;
  email: EmailMethods;
  publicUrl: () => string;
  now?: () => number;
}) {
  const { db, masterKey, email } = options;
  const now = options.now ?? Date.now;
  const seconds = () => Math.floor(now() / 1000);
  db.exec(`CREATE TABLE IF NOT EXISTS mfa_policies (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, required INTEGER NOT NULL, allowed TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mfa_methods (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL,last_step INTEGER,created_at INTEGER NOT NULL,last_used_at INTEGER);
    CREATE INDEX IF NOT EXISTS mfa_methods_user ON mfa_methods(user_id);
    CREATE TABLE IF NOT EXISTS mfa_requests (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_id TEXT NOT NULL,purpose TEXT NOT NULL,data TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS mfa_proofs (context TEXT PRIMARY KEY,user_id TEXT NOT NULL,method_id TEXT NOT NULL,data TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS mfa_limits (key TEXT PRIMARY KEY,window_start INTEGER NOT NULL,last_at INTEGER NOT NULL,count INTEGER NOT NULL);`);
  const encode = (value: unknown) => encryptSecret(Buffer.from(JSON.stringify(value)), masterKey);
  const decode = <T>(value: string): T =>
    JSON.parse(Buffer.from(decryptSecret(value, masterKey)).toString()) as T;
  function ensure(userId: string): void {
    const legacy = db
      .prepare("SELECT totp_secret_enc,totp_last_step FROM users WHERE id = ?")
      .get(userId) as { totp_secret_enc: string | null; totp_last_step: number | null } | undefined;
    if (!legacy) throw new AccountError("Account not found.", 404);
    db.prepare("INSERT OR IGNORE INTO mfa_policies VALUES (?,?,?)").run(
      userId,
      legacy.totp_secret_enc ? 1 : 0,
      JSON.stringify(kinds),
    );
    if (legacy.totp_secret_enc && legacy.totp_secret_enc !== LEGACY_MFA_GUARD) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT OR IGNORE INTO mfa_methods VALUES (?,?,?,?,?,?,?,NULL)").run(
          `legacy:${userId}`,
          userId,
          "totp",
          "Authenticator app",
          encode({
            secret: Buffer.from(decryptSecret(legacy.totp_secret_enc, masterKey)).toString(
              "base64url",
            ),
          }),
          legacy.totp_last_step,
          now(),
        );
        db.prepare("UPDATE users SET totp_secret_enc = ?,totp_last_step = NULL WHERE id = ?").run(
          LEGACY_MFA_GUARD,
          userId,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  }
  function policy(userId: string): FactorPolicy {
    ensure(userId);
    const row = db.prepare("SELECT * FROM mfa_policies WHERE user_id = ?").get(userId) as {
      required: number;
      allowed: string;
    };
    return { required: row.required === 1, allowed: JSON.parse(row.allowed) as FactorKind[] };
  }
  function rows(userId: string): FactorRow[] {
    ensure(userId);
    return db
      .prepare("SELECT * FROM mfa_methods WHERE user_id = ? ORDER BY created_at,id")
      .all(userId) as unknown as FactorRow[];
  }
  function method(userId: string, id: string): FactorRow {
    const row = rows(userId).find((row) => row.id === id);
    if (!row) throw new AccountError("This authentication method no longer exists.", 404);
    return row;
  }
  function list(userId: string): FactorView[] {
    return rows(userId).map((row) => {
      const value = decode<FactorData>(row.data);
      return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        detail:
          row.kind === "email"
            ? (value.address ?? "")
            : row.kind === "passkey"
              ? (value.rpID ?? "")
              : "Authenticator app",
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      };
    });
  }
  function allowed(userId: string): FactorView[] {
    const p = policy(userId);
    return list(userId).filter((row) => p.allowed.includes(row.kind));
  }
  function origin(): { origin: string; rpID: string } | null {
    try {
      const url = new URL(options.publicUrl());
      if (isIP(url.hostname) || url.hostname.startsWith("[")) return null;
      if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost"))
        return null;
      return { origin: url.origin, rpID: url.hostname };
    } catch {
      return null;
    }
  }
  function clean(): void {
    db.prepare("DELETE FROM mfa_requests WHERE expires_at <= ?").run(now());
    db.prepare("DELETE FROM mfa_proofs WHERE expires_at <= ?").run(now());
    db.prepare("DELETE FROM mfa_limits WHERE window_start < ?").run(now() - 3_600_000);
  }
  function limit(key: string, max: number, window: number, gap = 0): void {
    clean();
    const row = db.prepare("SELECT * FROM mfa_limits WHERE key = ?").get(key) as
      { window_start: number; last_at: number; count: number } | undefined;
    const active = row && row.window_start > now() - window;
    if (active && (row.count >= max || row.last_at > now() - gap))
      throw new AccountError(
        gap
          ? "Wait a minute before requesting another email code. At most ten codes can be sent per hour."
          : "Too many attempts. Wait five minutes before trying again.",
        429,
      );
    db.prepare(
      "INSERT INTO mfa_limits VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,last_at=excluded.last_at,count=excluded.count",
    ).run(key, active ? row.window_start : now(), now(), active ? row.count + 1 : 1);
  }
  function activeSession(userId: string, session: string): boolean {
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND u.status IN ('active','member') AND s.idle_expires_at>? AND s.absolute_expires_at>?",
        )
        .get(session, userId, seconds(), seconds()),
    );
  }
  function elevated(userId: string, session: string): boolean {
    return (
      activeSession(userId, session) &&
      Boolean(
        db
          .prepare("SELECT 1 FROM sessions WHERE id=? AND elevated_until>?")
          .get(session, seconds()),
      )
    );
  }
  function requireElevation(userId: string, session: string): void {
    if (!elevated(userId, session))
      throw new AccountError("Verify your identity again before changing account security.", 403);
  }
  function revokeOthers(userId: string, session: string): void {
    db.prepare("DELETE FROM sessions WHERE user_id=? AND id!=?").run(userId, session);
    db.prepare("DELETE FROM pending_logins WHERE user_id=?").run(userId);
    db.prepare("DELETE FROM mfa_requests WHERE user_id=? AND session_id!=?").run(userId, session);
    db.prepare("DELETE FROM mfa_proofs WHERE user_id=?").run(userId);
  }
  function request(userId: string, session: string, purpose: string, data: unknown): string {
    clean();
    db.prepare("DELETE FROM mfa_requests WHERE user_id=? AND session_id=? AND purpose=?").run(
      userId,
      session,
      purpose,
    );
    const token = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO mfa_requests VALUES (?,?,?,?,?,?,0)").run(
      digest(token),
      userId,
      session,
      purpose,
      encode(data),
      now() + 300_000,
    );
    return token;
  }
  function getRequest(
    userId: string,
    session: string,
    ticket: string,
    purpose: string,
  ): RequestRow {
    const row = db
      .prepare("SELECT * FROM mfa_requests WHERE id=? AND user_id=? AND session_id=? AND purpose=?")
      .get(digest(ticket), userId, session, purpose) as unknown as RequestRow | undefined;
    if (!row || row.expires_at <= now() || row.attempts >= 5 || !activeSession(userId, session))
      throw new AccountError("This verification expired. Start again.", 401);
    db.prepare("UPDATE mfa_requests SET attempts=attempts+1 WHERE id=?").run(row.id);
    return row;
  }
  const otpHash = (userId: string, code: string) =>
    createHmac("sha256", masterKey).update(`${userId}:${code}`).digest("hex");
  const otpMatches = (userId: string, code: string, expected: string) =>
    /^\d{6}$/.test(code) &&
    timingSafeEqual(Buffer.from(otpHash(userId, code)), Buffer.from(expected));
  async function sendCode(userId: string, deliveryId: string, address: string): Promise<string> {
    limit(`email:${userId}`, 10, 3_600_000, 60_000);
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    await email.send(deliveryId, [address], {
      title: `${product.name} · Verification code`,
      text: `Your verification code is ${code}. It expires in 5 minutes. Do not share it. If you did not request this code, you can ignore this message.`,
      key: randomUUID(),
    });
    return otpHash(userId, code);
  }
  async function challenge(userId: string, context: string, methodId: string): Promise<unknown> {
    if (!allowed(userId).some((m) => m.id === methodId))
      throw new AccountError("Choose an allowed authentication method.");
    const row = method(userId, methodId),
      data = decode<FactorData>(row.data);
    clean();
    let payload: unknown;
    let result: unknown = { sent: true };
    if (row.kind === "email")
      payload = {
        codeHash: await sendCode(userId, present(data.deliveryId), present(data.address)),
      };
    else if (row.kind === "passkey") {
      const current = origin();
      if (!current || data.origin !== current.origin)
        throw new AccountError("Open the panel at its saved HTTPS address to use this passkey.");
      const options = await generateAuthenticationOptions({
        rpID: current.rpID,
        allowCredentials: [
          {
            id: present(data.credentialId),
            ...(data.transports ? { transports: data.transports } : {}),
          },
        ],
        userVerification: "required",
      });
      payload = { challenge: options.challenge };
      result = options;
    } else return { ready: true };
    db.prepare(
      "INSERT INTO mfa_proofs VALUES (?,?,?,?,?,0) ON CONFLICT(context) DO UPDATE SET user_id=excluded.user_id,method_id=excluded.method_id,data=excluded.data,expires_at=excluded.expires_at,attempts=0",
    ).run(context, userId, methodId, encode(payload), now() + 300_000);
    return result;
  }
  function verifyTotp(userId: string, methodId: string, code: string): boolean {
    limit(`verify:${userId}`, 10, 300_000);
    if (!allowed(userId).some((m) => m.id === methodId && m.kind === "totp")) return false;
    const row = method(userId, methodId),
      data = decode<FactorData>(row.data);
    const step = matchTotp(
      Buffer.from(present(data.secret), "base64url"),
      code,
      now(),
      row.last_step,
    );
    if (step === null) return false;
    return Boolean(
      db
        .prepare(
          "UPDATE mfa_methods SET last_step=?,last_used_at=? WHERE id=? AND (last_step IS NULL OR last_step<?)",
        )
        .run(step, now(), row.id, step).changes,
    );
  }
  async function verify(
    userId: string,
    context: string,
    methodId: string,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    const selected =
      methodId === "recovery" ? null : allowed(userId).find((method) => method.id === methodId);
    if (selected?.kind !== "totp") limit(`verify:${userId}`, 10, 300_000);
    if (methodId === "recovery")
      return Boolean(
        db
          .prepare(
            "UPDATE recovery_codes SET used_at=? WHERE user_id=? AND code_hash=? AND used_at IS NULL",
          )
          .run(seconds(), userId, recoveryHash(text(input["code"]))).changes,
      );
    if (!allowed(userId).some((m) => m.id === methodId)) return false;
    const row = method(userId, methodId),
      data = decode<FactorData>(row.data);
    if (row.kind === "totp") return verifyTotp(userId, methodId, text(input["code"]));
    const proof = db
      .prepare("SELECT * FROM mfa_proofs WHERE context=? AND user_id=? AND method_id=?")
      .get(context, userId, methodId) as
      { data: string; expires_at: number; attempts: number } | undefined;
    if (!proof || proof.expires_at <= now() || proof.attempts >= 5) return false;
    db.prepare("UPDATE mfa_proofs SET attempts=attempts+1 WHERE context=?").run(context);
    const payload = decode<{ codeHash?: string; challenge?: string }>(proof.data);
    if (row.kind === "email") {
      if (!otpMatches(userId, text(input["code"]), present(payload.codeHash))) return false;
      db.prepare("DELETE FROM mfa_proofs WHERE context=?").run(context);
    } else {
      db.prepare("DELETE FROM mfa_proofs WHERE context=?").run(context);
      const current = origin();
      if (!current || current.origin !== data.origin || current.rpID !== data.rpID) return false;
      try {
        const verified = await verifyAuthenticationResponse({
          response: record(input["response"]) as unknown as AuthenticationResponseJSON,
          expectedChallenge: present(payload.challenge),
          expectedOrigin: data.origin,
          expectedRPID: data.rpID,
          credential: {
            id: present(data.credentialId),
            publicKey: new Uint8Array(Buffer.from(present(data.publicKey), "base64url")),
            counter: present(data.counter),
            ...(data.transports ? { transports: data.transports } : {}),
          },
          requireUserVerification: true,
        });
        if (!verified.verified) return false;
        data.counter = verified.authenticationInfo.newCounter;
        if (
          !db
            .prepare("UPDATE mfa_methods SET data=? WHERE id=? AND data=?")
            .run(encode(data), row.id, row.data).changes
        )
          return false;
      } catch {
        return false;
      }
    }
    db.prepare("UPDATE mfa_methods SET last_used_at=? WHERE id=?").run(now(), row.id);
    return true;
  }
  return {
    policy,
    allowed,
    challenge,
    verify,
    verifyTotp,
    view(userId: string, session: string): AccountSecurityView {
      return {
        methods: list(userId),
        policy: policy(userId),
        recoveryRemaining: (
          db
            .prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id=? AND used_at IS NULL")
            .get(userId) as { n: number }
        ).n,
        elevated: elevated(userId, session),
        passkeyOrigin: origin()?.origin ?? null,
      };
    },
    assertPublicUrl(next: string): void {
      const url = new URL(next);
      for (const row of db.prepare("SELECT data FROM mfa_methods WHERE kind='passkey'").all() as {
        data: string;
      }[])
        if (decode<FactorData>(row.data).origin !== url.origin)
          throw new AccountError(
            "Passkeys use the current panel address. Add another authentication method and remove those passkeys before changing the address.",
            409,
          );
    },
    async beginReauth(
      userId: string,
      session: string,
      password: string,
    ): Promise<{ verified: boolean; ticket?: string; methods?: FactorView[] }> {
      limit(`reauth:${userId}`, 5, 300_000);
      const row = db
        .prepare("SELECT password_hash FROM users WHERE id=? AND status IN ('active','member')")
        .get(userId) as { password_hash: string } | undefined;
      if (
        !row ||
        !(await verifyPassword(row.password_hash, password)) ||
        !activeSession(userId, session) ||
        !db
          .prepare("SELECT 1 FROM users WHERE id=? AND password_hash=?")
          .get(userId, row.password_hash)
      )
        throw new AccountError("Your current password could not be verified.", 401);
      if (!policy(userId).required) {
        db.prepare("UPDATE sessions SET elevated_until=? WHERE id=?").run(seconds() + 300, session);
        return { verified: true };
      }
      return {
        verified: false,
        ticket: request(userId, session, "reauth", {}),
        methods: allowed(userId),
      };
    },
    async reauthChallenge(
      userId: string,
      session: string,
      ticket: string,
      methodId: string,
    ): Promise<unknown> {
      getRequest(userId, session, ticket, "reauth");
      return challenge(userId, `reauth:${digest(ticket)}`, methodId);
    },
    async finishReauth(
      userId: string,
      session: string,
      ticket: string,
      methodId: string,
      input: Record<string, unknown>,
    ): Promise<void> {
      const row = getRequest(userId, session, ticket, "reauth");
      if (
        !(await verify(userId, `reauth:${row.id}`, methodId, input)) ||
        !activeSession(userId, session)
      )
        throw new AccountError(
          "Verification failed. Check the code or choose another method.",
          401,
        );
      if (
        !db.prepare("DELETE FROM mfa_requests WHERE id=? AND expires_at>?").run(row.id, now())
          .changes
      )
        throw new AccountError("This verification has already been used.", 401);
      db.prepare("UPDATE sessions SET elevated_until=? WHERE id=?").run(seconds() + 300, session);
    },
    async beginEnrollment(
      userId: string,
      session: string,
      input: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      requireElevation(userId, session);
      if (rows(userId).length >= 20)
        throw new AccountError("You can save up to 20 authentication methods.");
      const kind = text(input["kind"]) as FactorKind;
      if (!kinds.includes(kind)) throw new AccountError("Choose an authentication method.");
      const value: Enrollment = { kind, name: nameOf(input["name"]) };
      let result: Record<string, unknown> = {};
      if (kind === "totp") {
        const secret = totpSecret();
        value.secret = Buffer.from(secret).toString("base64url");
        const user = db.prepare("SELECT username FROM users WHERE id=?").get(userId) as {
          username: string;
        };
        result = { secret: totpSecretText(secret), uri: totpUri(user.username, secret) };
      }
      if (kind === "email") {
        value.address = emailAddress(input["address"]);
        value.deliveryId = text(input["deliveryId"]);
        if (!email.available(value.deliveryId))
          throw new AccountError("Set up an email delivery method in Settings → Email first.");
        value.codeHash = await sendCode(userId, value.deliveryId, value.address);
        result = { sent: true };
      }
      if (kind === "passkey") {
        const current = origin();
        if (!current)
          throw new AccountError(
            "Passkeys need the panel's saved HTTPS domain, or localhost for development.",
          );
        const user = db.prepare("SELECT username FROM users WHERE id=?").get(userId) as {
          username: string;
        };
        const registration = await generateRegistrationOptions({
          rpName: product.name,
          rpID: current.rpID,
          userName: user.username,
          userID: new TextEncoder().encode(userId),
          attestationType: "none",
          excludeCredentials: rows(userId)
            .filter((r) => r.kind === "passkey")
            .map((r) => ({ id: present(decode<FactorData>(r.data).credentialId) })),
          authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        });
        Object.assign(value, current, { challenge: registration.challenge });
        result = { options: registration };
      }
      requireElevation(userId, session);
      return { ...result, ticket: request(userId, session, "enroll", value) };
    },
    async finishEnrollment(
      userId: string,
      session: string,
      ticket: string,
      input: Record<string, unknown>,
    ): Promise<void> {
      requireElevation(userId, session);
      const req = getRequest(userId, session, ticket, "enroll"),
        value = decode<Enrollment>(req.data);
      let step: number | null = null;
      if (value.kind === "totp") {
        step = matchTotp(
          Buffer.from(present(value.secret), "base64url"),
          text(input["code"]),
          now(),
          null,
        );
        if (step === null) throw new AccountError("That authenticator code is not valid.", 401);
      }
      if (
        value.kind === "email" &&
        !otpMatches(userId, text(input["code"]), present(value.codeHash))
      )
        throw new AccountError("That email code is not valid.", 401);
      if (value.kind === "passkey") {
        if (origin()?.origin !== value.origin)
          throw new AccountError("The panel address changed. Start enrollment again.", 409);
        let verified;
        try {
          verified = await verifyRegistrationResponse({
            response: record(input["response"]) as unknown as RegistrationResponseJSON,
            expectedChallenge: present(value.challenge),
            expectedOrigin: present(value.origin),
            expectedRPID: present(value.rpID),
            requireUserVerification: true,
          });
        } catch {
          throw new AccountError("Passkey verification failed. Start enrollment again.", 401);
        }
        if (!verified.verified || !verified.registrationInfo)
          throw new AccountError("The passkey could not be verified.", 401);
        const credential = verified.registrationInfo.credential;
        value.credentialId = credential.id;
        value.publicKey = Buffer.from(credential.publicKey).toString("base64url");
        value.counter = credential.counter;
        if (credential.transports) value.transports = credential.transports;
        for (const row of db.prepare("SELECT data FROM mfa_methods WHERE kind='passkey'").all() as {
          data: string;
        }[])
          if (decode<FactorData>(row.data).credentialId === credential.id)
            throw new AccountError("This passkey is already registered.", 409);
      }
      requireElevation(userId, session);
      const id = randomUUID();
      delete value.codeHash;
      delete value.challenge;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (
          !db.prepare("DELETE FROM mfa_requests WHERE id=? AND expires_at>?").run(req.id, now())
            .changes
        )
          throw new AccountError("This setup has expired or already been used.", 401);
        if (rows(userId).length >= 20)
          throw new AccountError("You can save up to 20 authentication methods.");
        if (value.kind === "email") email.bind(`mfa:${id}`, present(value.deliveryId));
        db.prepare("INSERT INTO mfa_methods VALUES (?,?,?,?,?,?,?,NULL)").run(
          id,
          userId,
          value.kind,
          value.name,
          encode(value),
          step,
          now(),
        );
        if (input["requireAfter"] === true) {
          const current = policy(userId);
          db.prepare("UPDATE mfa_policies SET required=1,allowed=? WHERE user_id=?").run(
            JSON.stringify([...new Set([...current.allowed, value.kind])]),
            userId,
          );
          db.prepare("UPDATE users SET totp_secret_enc=? WHERE id=?").run(LEGACY_MFA_GUARD, userId);
        }
        revokeOthers(userId, session);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    savePolicy(userId: string, session: string, input: Record<string, unknown>): void {
      requireElevation(userId, session);
      if (
        typeof input["required"] !== "boolean" ||
        !Array.isArray(input["allowed"]) ||
        input["allowed"].some((k) => !kinds.includes(k as FactorKind))
      )
        throw new AccountError("Choose a valid two-factor policy.");
      const selected = [...new Set(input["allowed"] as FactorKind[])];
      if (!selected.length) throw new AccountError("Allow at least one method type.");
      if (input["required"] && !rows(userId).some((row) => selected.includes(row.kind)))
        throw new AccountError(
          "Set up an allowed authentication method before requiring two-factor sign-in.",
        );
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE mfa_policies SET required=?,allowed=? WHERE user_id=?").run(
          input["required"] ? 1 : 0,
          JSON.stringify(selected),
          userId,
        );
        db.prepare("UPDATE users SET totp_secret_enc=? WHERE id=?").run(
          input["required"] ? LEGACY_MFA_GUARD : null,
          userId,
        );
        revokeOthers(userId, session);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    rename(userId: string, session: string, id: string, name: unknown): void {
      requireElevation(userId, session);
      method(userId, id);
      db.prepare("UPDATE mfa_methods SET name=? WHERE id=?").run(nameOf(name), id);
    },
    remove(userId: string, session: string, id: string): void {
      requireElevation(userId, session);
      method(userId, id);
      const p = policy(userId);
      if (p.required && !rows(userId).some((row) => row.id !== id && p.allowed.includes(row.kind)))
        throw new AccountError(
          "Add another allowed method or explicitly turn off the requirement before removing your last method.",
          409,
        );
      db.exec("BEGIN IMMEDIATE");
      try {
        email.unbind(`mfa:${id}`);
        db.prepare("DELETE FROM mfa_methods WHERE id=? AND user_id=?").run(id, userId);
        revokeOthers(userId, session);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    recoveryCodes(userId: string, session: string): string[] {
      requireElevation(userId, session);
      const codes = Array.from({ length: 10 }, () =>
        randomBytes(12)
          .toString("hex")
          .replace(/(.{6})(?=.)/g, "$1-"),
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM recovery_codes WHERE user_id=?").run(userId);
        for (const code of codes)
          db.prepare("INSERT INTO recovery_codes VALUES (?,?,?,NULL,?)").run(
            randomUUID(),
            userId,
            recoveryHash(code),
            seconds(),
          );
        revokeOthers(userId, session);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return codes;
    },
  };
}
export type Factors = ReturnType<typeof createFactors>;
