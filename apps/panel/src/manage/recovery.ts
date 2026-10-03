// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { DatabaseSync } from "node:sqlite";
import { createAudit } from "../audit/log.ts";
import { hashPassword, passwordProblem } from "../auth/password.ts";
import { defaultLoginSecurity } from "../auth/security.ts";
import { ManageError } from "./errors.ts";

interface RecoveryUser {
  id: string;
  username: string;
  password_hash: string | null;
  status: string;
}
const safe = (value: unknown): string =>
  String(value ?? "")
    .replace(/\p{Cc}/gu, "?")
    .slice(0, 200);

/** Operates on an existing database without running application migrations. */
export function recoveryStore(db: DatabaseSync) {
  const has = (table: string): boolean =>
    Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  if (!["users", "sessions", "pending_logins", "recovery_codes"].every(has))
    throw new ManageError(
      "This is not an initialized panel database. Start the panel and complete setup first.",
    );
  function user(username: string): RecoveryUser {
    const found = db
      .prepare("SELECT id,username,password_hash,status FROM users WHERE username=? COLLATE NOCASE")
      .get(username) as RecoveryUser | undefined;
    if (!found)
      throw new ManageError("Account not found. Run unpanel-manage users to list account names.");
    return found;
  }
  function current(expected: RecoveryUser): RecoveryUser {
    const found = user(expected.username);
    if (
      found.id !== expected.id ||
      found.password_hash !== expected.password_hash ||
      found.status !== expected.status
    )
      throw new ManageError("The account changed during recovery. Run the command again.");
    return found;
  }
  function change<T>(action: string, target: string | null, work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      createAudit(db).record({
        action,
        result: "ok",
        actorKind: "system",
        target,
        params: { source: "terminal" },
      });
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function revoke(id: string): void {
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    db.prepare("DELETE FROM pending_logins WHERE user_id=?").run(id);
    for (const table of ["mfa_requests", "mfa_proofs"])
      if (has(table)) db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id);
  }
  function policy(): {
    turnstile?: { enabled?: boolean };
    loginRestrictions?: {
      enabled?: boolean;
      rateLimit?: { enabled?: boolean };
      banIp?: { enabled?: boolean };
      banPanel?: { enabled?: boolean };
    };
  } | null {
    if (!has("settings")) return null;
    const row = db.prepare("SELECT value_json FROM settings WHERE key='security.login'").get();
    if (!row) return null;
    try {
      const value: unknown = JSON.parse(String(row["value_json"]));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw new ManageError(
        "The saved sign-in policy is invalid. Restore a valid database backup before changing it.",
      );
    }
  }
  return {
    user,
    users(): string {
      const access = has("user_access");
      const rows = db
        .prepare(
          `SELECT u.username,u.status${access ? ",a.role,a.locked" : ""} FROM users u ${access ? "LEFT JOIN user_access a ON a.user_id=u.id" : ""} ORDER BY u.created_at,u.id LIMIT 101`,
        )
        .all();
      return [
        "USERNAME\tROLE\tSTATUS\tDEMO",
        ...rows.map((row) =>
          [row["username"], row["role"] ?? "legacy", row["status"], row["locked"] ? "locked" : "no"]
            .map(safe)
            .join("\t"),
        ),
        ...(!rows.length ? ["No accounts yet. Complete setup in the browser."] : []),
        "",
      ].join("\n");
    },
    security(): string {
      const stored = policy();
      const fallback = defaultLoginSecurity().loginRestrictions;
      const restrictions = stored?.loginRestrictions;
      const enabled = (value: unknown, otherwise: boolean): string =>
        (typeof value === "boolean" ? value : otherwise) ? "enabled" : "disabled";
      const bans = has("auth_bans")
        ? db
            .prepare(
              "SELECT kind,key,expires_at FROM auth_bans WHERE expires_at IS NULL OR expires_at>? ORDER BY kind,key LIMIT 200",
            )
            .all(Math.floor(Date.now() / 1000))
        : [];
      return [
        `Turnstile: ${stored?.turnstile?.enabled === true ? "enabled" : "disabled"}`,
        `Sign-in restrictions: ${enabled(restrictions?.enabled, fallback.enabled)}`,
        `Rate limit: ${enabled(restrictions?.rateLimit?.enabled, fallback.rateLimit.enabled)}`,
        `IP ban policy: ${enabled(restrictions?.banIp?.enabled, fallback.banIp.enabled)}`,
        `Panel lock policy: ${enabled(restrictions?.banPanel?.enabled, fallback.banPanel.enabled)}`,
        `Active sign-in locks: ${bans.length}${bans.length === 200 ? " (first 200)" : ""}`,
        ...bans.map(
          (row) =>
            `${safe(row["kind"])}\t${safe(row["key"])}\t${row["expires_at"] === null ? "permanent" : `until ${new Date(Number(row["expires_at"]) * 1000).toISOString()}`}`,
        ),
        "Use unlock for the panel lock, or unban IP for one address.",
        "",
      ].join("\n");
    },
    unlock(): string {
      const changed = change("security.panel.unlock", null, () => {
        const result = has("auth_bans")
          ? db.prepare("DELETE FROM auth_bans WHERE kind='panel' AND key='panel'").run().changes
          : 0;
        if (has("auth_attempts"))
          db.prepare("DELETE FROM auth_attempts WHERE scope='panel' AND key='panel'").run();
        return Number(result) > 0;
      });
      return changed
        ? "Panel sign-in lock removed. You can try signing in again.\n"
        : "The panel was not locked. Its panel-wide failed-attempt counter was reset.\n";
    },
    unban(ip: string): string {
      change("security.ip.unban", ip, () => {
        if (has("auth_bans")) db.prepare("DELETE FROM auth_bans WHERE kind='ip' AND key=?").run(ip);
        if (has("auth_attempts"))
          db.prepare("DELETE FROM auth_attempts WHERE scope='ip' AND key=?").run(ip);
      });
      return `Sign-in ban and IP attempt counter cleared for ${ip}.\n`;
    },
    disableTurnstile(): string {
      const changed = change("security.turnstile.disable", null, () => {
        const stored = policy();
        if (!stored) return false;
        if (
          !stored.turnstile ||
          typeof stored.turnstile !== "object" ||
          Array.isArray(stored.turnstile)
        )
          throw new ManageError("The saved Turnstile policy is invalid. Nothing was changed.");
        return (
          Number(
            db
              .prepare(
                "UPDATE settings SET value_json=json_set(value_json,'$.turnstile.enabled',json('false')),updated_at=?,updated_by='local-recovery' WHERE key='security.login'",
              )
              .run(Math.floor(Date.now() / 1000)).changes,
          ) > 0
        );
      });
      return changed
        ? "Turnstile disabled. Refresh the sign-in page; no restart is needed. Re-enable it in Settings → Security after recovery.\n"
        : "Turnstile is already disabled (no saved policy).\n";
    },
    async resetPassword(expected: RecoveryUser, password: string): Promise<void> {
      const problem = passwordProblem(password, expected.username);
      if (problem) throw new ManageError(problem);
      const hash = await hashPassword(password);
      change("auth.password.reset", expected.id, () => {
        const found = current(expected);
        db.prepare("UPDATE users SET password_hash=?,updated_at=? WHERE id=?").run(
          hash,
          Math.floor(Date.now() / 1000),
          found.id,
        );
        revoke(found.id);
        if (has("auth_attempts"))
          db.prepare("DELETE FROM auth_attempts WHERE scope='user' AND key=?").run(
            found.username.toLowerCase(),
          );
      });
    },
    resetFactors(expected: RecoveryUser): void {
      change("auth.factors.reset", expected.id, () => {
        const found = current(expected);
        if (has("mfa_methods") && has("email_method_refs"))
          db.prepare(
            "DELETE FROM email_method_refs WHERE consumer IN (SELECT 'mfa:'||id FROM mfa_methods WHERE user_id=?)",
          ).run(found.id);
        for (const table of ["mfa_methods", "mfa_policies", "recovery_codes"])
          if (has(table)) db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(found.id);
        if (has("mfa_limits"))
          for (const kind of ["verify", "reauth", "email"])
            db.prepare("DELETE FROM mfa_limits WHERE key=?").run(`${kind}:${found.id}`);
        db.prepare(
          "UPDATE users SET totp_secret_enc=NULL,totp_last_step=NULL,updated_at=? WHERE id=?",
        ).run(Math.floor(Date.now() / 1000), found.id);
        revoke(found.id);
      });
    },
  };
}
