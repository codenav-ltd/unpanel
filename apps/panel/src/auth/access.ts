// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  managesPanel,
  seesNode,
  type ManagedUser,
  type UserAccess,
  type UserRole,
} from "@unpanel/shared";
import { AccountError } from "./account-error.ts";
import { hashPassword, passwordProblem, usernameProblem } from "./password.ts";

const denied: UserAccess = { role: "viewer", nodeIds: [], locked: true };
export function createAccess(db: DatabaseSync) {
  const installed = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_access'")
    .get();
  db.exec(
    "CREATE TABLE IF NOT EXISTS user_mode (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL); INSERT OR IGNORE INTO user_mode VALUES (1,'single')",
  );
  const mode = (): "single" | "team" =>
    db.prepare("SELECT mode FROM user_mode WHERE id=1").get()?.["mode"] === "team"
      ? "team"
      : "single";
  if (!installed) db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS user_access (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL, node_ids TEXT, locked INTEGER NOT NULL DEFAULT 0
  )`);
    if (!installed)
      db.exec(`INSERT INTO user_access(user_id,role,node_ids,locked)
    SELECT id, 'owner', NULL, 0 FROM users ORDER BY created_at LIMIT 1`);
    if (!installed) db.exec("COMMIT");
  } catch (error) {
    if (!installed) db.exec("ROLLBACK");
    throw error;
  }
  function get(id: string): UserAccess {
    const row = db
      .prepare("SELECT role,node_ids,locked FROM user_access WHERE user_id=?")
      .get(id) as { role: UserRole; node_ids: string | null; locked: number } | undefined;
    return row
      ? {
          role: row.role,
          nodeIds: row.node_ids === null ? null : (JSON.parse(row.node_ids) as string[]),
          locked: Boolean(row.locked),
        }
      : { ...denied };
  }
  function owner(actor: string, session: string): void {
    const now = Math.floor(Date.now() / 1000);
    if (
      get(actor).role !== "owner" ||
      !db
        .prepare(
          `SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=? AND s.user_id=? AND u.status='active' AND s.elevated_until>? AND s.idle_expires_at>? AND s.absolute_expires_at>?`,
        )
        .get(session, actor, now, now, now)
    )
      throw new AccountError("Confirm your identity as an owner before managing users.", 403);
  }
  function list(): ManagedUser[] {
    return (
      db
        .prepare(
          "SELECT id,username,display_name,status,last_login_at FROM users ORDER BY created_at,id",
        )
        .all() as unknown as {
        id: string;
        username: string;
        display_name: string | null;
        status: string;
        last_login_at: number | null;
      }[]
    ).map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name ?? "",
      enabled: row.status === "active" || row.status === "member",
      lastLoginAt: row.last_login_at,
      ...get(row.id),
    }));
  }
  function fields(body: Record<string, unknown>): {
    access: UserAccess;
    displayName: string;
    enabled: boolean;
  } {
    if (!["owner", "admin", "operator", "viewer"].includes(String(body["role"])))
      throw new AccountError("Choose a user role.");
    const role = body["role"] as UserRole;
    if (typeof body["enabled"] !== "boolean" || typeof body["locked"] !== "boolean")
      throw new AccountError("Choose the account status and demo mode.");
    if (body["locked"] && role !== "viewer")
      throw new AccountError("Demo accounts must use the Viewer role.");
    let nodeIds: string[] | null = null;
    if (body["nodeIds"] !== null) {
      if (
        !Array.isArray(body["nodeIds"]) ||
        body["nodeIds"].length > 1000 ||
        body["nodeIds"].some(
          (id) => typeof id !== "string" || !db.prepare("SELECT 1 FROM nodes WHERE id=?").get(id),
        )
      )
        throw new AccountError("Choose existing nodes or all nodes.");
      nodeIds = [...new Set(body["nodeIds"] as string[])];
    }
    if ((role === "owner" || role === "admin") && nodeIds !== null)
      throw new AccountError(
        "Owners and administrators manage the whole panel. Choose Operator or Viewer for a node scope.",
      );
    const displayName = body["displayName"] ?? "";
    if (typeof displayName !== "string" || displayName.length > 80)
      throw new AccountError("Keep the display name within 80 characters.");
    return {
      access: { role, nodeIds, locked: body["locked"] },
      displayName: displayName.trim(),
      enabled: body["enabled"],
    };
  }
  function store(id: string, value: UserAccess): void {
    db.prepare(
      "INSERT INTO user_access VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,node_ids=excluded.node_ids,locked=excluded.locked",
    ).run(
      id,
      value.role,
      value.nodeIds === null ? null : JSON.stringify(value.nodeIds),
      Number(value.locked),
    );
  }
  function revoke(id: string): void {
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    db.prepare("DELETE FROM pending_logins WHERE user_id=?").run(id);
    for (const table of ["mfa_requests", "mfa_proofs"])
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table))
        db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id);
  }
  function keepOwner(id: string, actor: string, enabled: boolean, role: UserRole): void {
    if (id === actor && (!enabled || role !== "owner"))
      throw new AccountError(
        "Another owner must change your access. You cannot disable or demote your own account.",
        409,
      );
    if (
      get(id).role === "owner" &&
      (!enabled || role !== "owner") &&
      !db
        .prepare(
          "SELECT 1 FROM users u JOIN user_access a ON a.user_id=u.id WHERE a.role='owner' AND u.status='active' AND u.id<>?",
        )
        .get(id)
    )
      throw new AccountError("Keep at least one active owner.", 409);
  }
  function transaction(work: () => void): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      work();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    get,
    list,
    owner,
    mode,
    setMode(actor: string, session: string, next: unknown, confirmation: unknown): void {
      owner(actor, session);
      if (next !== "single" && next !== "team")
        throw new AccountError("Choose single-user or team mode.");
      if (next === mode()) return;
      if (next === "single" && confirmation !== "single")
        throw new AccountError("Type single to confirm disabling every other user.");
      transaction(() => {
        if (next === "single")
          for (const user of list())
            if (user.id !== actor) {
              db.prepare("UPDATE users SET status='disabled',updated_at=? WHERE id=?").run(
                Math.floor(Date.now() / 1000),
                user.id,
              );
              revoke(user.id);
            }
        db.prepare("UPDATE user_mode SET mode=? WHERE id=1").run(next);
      });
    },
    setupOwner(id: string): void {
      store(id, { role: "owner", nodeIds: null, locked: false });
    },
    async save(
      actor: string,
      session: string,
      body: Record<string, unknown>,
      id?: string,
    ): Promise<void> {
      owner(actor, session);
      if (mode() !== "team") throw new AccountError("Enable team mode before managing users.", 403);
      const value = fields(body),
        existing = id ? list().find((user) => user.id === id) : undefined;
      if (id && !existing) throw new AccountError("This user no longer exists.", 404);
      const username =
        existing?.username ?? (typeof body["username"] === "string" ? body["username"].trim() : "");
      const problem = usernameProblem(username);
      if (problem) throw new AccountError(problem);
      const password = body["password"];
      if (typeof password !== "string" || (!id && !password))
        throw new AccountError("Set a password for the new account.");
      if (password) {
        const problem = passwordProblem(password, username);
        if (problem) throw new AccountError(problem);
      }
      if (id === actor && password)
        throw new AccountError("Use Security → Change password for your own account.");
      const passwordHash = password ? await hashPassword(password) : null;
      // Password hashing yields: recheck the actor's session and all write invariants afterwards.
      owner(actor, session);
      transaction(() => {
        if (mode() !== "team")
          throw new AccountError("Team mode was disabled. Reload this page.", 403);
        if (!id && list().length >= 100)
          throw new AccountError("This panel supports up to 100 users.");
        if (id && !db.prepare("SELECT 1 FROM users WHERE id=?").get(id))
          throw new AccountError("This user no longer exists.", 404);
        if (
          db
            .prepare("SELECT 1 FROM users WHERE username=? COLLATE NOCASE AND id<>?")
            .get(username, id ?? "")
        )
          throw new AccountError("That username is already in use.", 409);
        const userId = id ?? randomUUID(),
          now = Math.floor(Date.now() / 1000);
        keepOwner(userId, actor, value.enabled, value.access.role);
        // Pre-RBAC binaries accept only 'active', so members cannot gain owner access on downgrade.
        const status = value.enabled
          ? value.access.role === "owner"
            ? "active"
            : "member"
          : "disabled";
        if (id)
          db.prepare(
            "UPDATE users SET display_name=?,status=?,password_hash=COALESCE(?,password_hash),updated_at=? WHERE id=?",
          ).run(value.displayName, status, passwordHash, now, id);
        else
          db.prepare(
            "INSERT INTO users(id,username,display_name,password_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
          ).run(userId, username, value.displayName, passwordHash, status, now, now);
        store(userId, value.access);
        if (id && id !== actor) revoke(id);
      });
    },
    remove(actor: string, session: string, id: string): void {
      owner(actor, session);
      if (!list().some((user) => user.id === id))
        throw new AccountError("This user no longer exists.", 404);
      transaction(() => {
        keepOwner(id, actor, false, "viewer");
        revoke(id);
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='mfa_methods'").get()) {
          db.prepare(
            "DELETE FROM email_method_refs WHERE consumer IN (SELECT 'mfa:' || id FROM mfa_methods WHERE user_id=?)",
          ).run(id);
        }
        db.prepare("DELETE FROM users WHERE id=?").run(id);
      });
    },
    permits(id: string, method: string, path: string): boolean {
      const access = get(id),
        read = method === "GET" || method === "HEAD";
      if (
        path === "/api/v1/me" ||
        (read &&
          ["/api/v1/settings", "/api/v1/about", "/api/v1/updates", "/api/v1/nodes"].includes(path))
      )
        return read;
      if (path.startsWith("/api/v1/me/")) return read || !access.locked;
      if (
        path.startsWith("/api/v1/backup/") ||
        path.startsWith("/api/v1/security/") ||
        path === "/api/v1/user-mode"
      )
        return access.role === "owner" && !access.locked;
      if (path === "/api/v1/users" || path.startsWith("/api/v1/users/"))
        return access.role === "owner" && !access.locked;
      const node = /^\/api\/v1\/nodes\/([^/]+)(.*)$/.exec(path);
      if (node) {
        let id: string;
        try {
          id = decodeURIComponent(node[1] ?? "");
        } catch {
          return false;
        }
        if (!seesNode(access, id)) return false;
        if (read) return node[2] === "" || node[2] === "/history";
        if (managesPanel(access)) return true;
        return (
          !access.locked &&
          access.role === "operator" &&
          ((method === "PATCH" && node[2] === "") ||
            (method === "POST" &&
              ["/restart", "/stop", "/swap", "/update"].includes(node[2] ?? "")))
        );
      }
      return managesPanel(access);
    },
  };
}
export type Access = ReturnType<typeof createAccess>;
