// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const PENDING_RESTORE = "pending-restore.db";
export const LIVE_DB = "panel.db";
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0");

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

/**
 * A consistent snapshot. `VACUUM INTO` folds WAL pages in and does not need the
 * `node:sqlite` `backup()` helper, which only exists on Node 23+.
 */
export async function exportPanelDb(db: DatabaseSync, dest: string): Promise<void> {
  const path = dest.replaceAll("\\", "/").replaceAll("'", "''");
  db.exec(`VACUUM INTO '${path}'`);
}

export function isSqliteFile(bytes: Uint8Array): boolean {
  if (bytes.byteLength < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i += 1) {
    if (bytes[i] !== SQLITE_MAGIC[i]) return false;
  }
  return true;
}

/** A restore file must be a SQLite database that already has our users table. */
export function validatePanelBackup(path: string): void {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .get();
    if (!row) throw new BackupError("This file is not an Unpanel backup.");
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("This file is not a readable SQLite database.");
  } finally {
    db?.close();
  }
}

/**
 * Stage the upload. The live database stays open; the next process start applies it
 * (`applyPendingRestore`) so a restore cannot race the current WAL.
 */
export function stageRestore(dataDir: string, bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_BACKUP_BYTES) {
    throw new BackupError(`Backup is larger than ${MAX_BACKUP_BYTES} bytes.`);
  }
  if (!isSqliteFile(bytes)) throw new BackupError("This file is not a SQLite database.");
  mkdirSync(dataDir, { recursive: true });
  const pending = join(dataDir, PENDING_RESTORE);
  writeFileSync(pending, bytes);
  try {
    validatePanelBackup(pending);
  } catch (error) {
    unlinkSync(pending);
    throw error;
  }
}

/** Called before the live database is opened. Safe to run when nothing is pending. */
export function applyPendingRestore(dataDir: string): boolean {
  const pending = join(dataDir, PENDING_RESTORE);
  if (!existsSync(pending)) return false;
  validatePanelBackup(pending);
  const live = join(dataDir, LIVE_DB);
  if (existsSync(live)) {
    const stamp = Date.now();
    const archive = join(dataDir, "backups");
    mkdirSync(archive, { recursive: true });
    renameSync(live, join(archive, `pre-restore-${stamp}.db`));
    for (const suffix of ["-wal", "-shm"]) {
      const side = `${live}${suffix}`;
      if (existsSync(side)) renameSync(side, join(archive, `pre-restore-${stamp}.db${suffix}`));
    }
  }
  renameSync(pending, live);
  return true;
}

export function backupFilename(at: Date = new Date()): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  return `unpanel-${y}${m}${d}.db`;
}
