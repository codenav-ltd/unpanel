// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPendingRestore } from "../backup/panel.ts";
import { openDatabase } from "../db/open.ts";
import type { DatabaseSync } from "node:sqlite";

export function openPanelData(dataDir: string): {
  db: DatabaseSync;
  masterKey: Buffer;
  readSetupToken: () => string | null;
  clearSetupToken: () => void;
} {
  mkdirSync(dataDir, { recursive: true });
  applyPendingRestore(dataDir);
  const db = openDatabase(join(dataDir, "panel.db"));
  const masterKey = loadMasterKey(dataDir);
  const tokenFile = join(dataDir, "setup-token");
  const hasUsers = userCount(db) > 0;
  if (hasUsers) {
    if (existsSync(tokenFile)) unlinkSync(tokenFile);
  } else if (!existsSync(tokenFile)) {
    writeFileSync(tokenFile, `st_${randomBytes(32).toString("base64url")}`, { mode: 0o600 });
  }

  return {
    db,
    masterKey,
    readSetupToken: () => {
      if (!existsSync(tokenFile)) return null;
      return readFileSync(tokenFile, "utf8").trim();
    },
    clearSetupToken: () => {
      if (existsSync(tokenFile)) unlinkSync(tokenFile);
    },
  };
}

function loadMasterKey(dataDir: string): Buffer {
  const file = join(dataDir, "master.key");
  if (existsSync(file)) {
    const key = readFileSync(file);
    if (key.length !== 32) throw new Error("master.key must be 32 bytes");
    return key;
  }
  const key = randomBytes(32);
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}

function userCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users").get() as
    { n: number | bigint } | undefined;
  return Number(row?.n ?? 0);
}
