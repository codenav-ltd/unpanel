// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Thin SQLite access. The v1 driver in ADR-0006 is better-sqlite3; M0 uses node:sqlite so the panel has no native module yet. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT,
      password_hash TEXT,
      totp_secret_enc TEXT,
      totp_last_step INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      locale TEXT,
      theme TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS recovery_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      auth_method TEXT NOT NULL,
      elevated_until INTEGER,
      ip TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      idle_expires_at INTEGER NOT NULL,
      absolute_expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS pending_logins (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      webauthn_challenge TEXT,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}
