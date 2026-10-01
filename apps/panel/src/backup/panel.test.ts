// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/open.ts";
import {
  applyPendingRestore,
  backupFilename,
  exportPanelDb,
  isSqliteFile,
  PENDING_RESTORE,
  stageRestore,
} from "./panel.ts";

describe("panel backup", () => {
  it("exports a snapshot that can be staged and applied on the next open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unpanel-bak-"));
    try {
      const live = join(dir, "panel.db");
      const source = openDatabase(live);
      source
        .prepare("INSERT INTO users (id, username, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run("u1", "ada", 1, 1);
      const snap = join(dir, "snap.db");
      await exportPanelDb(source, snap);
      source.close();

      const bytes = readFileSync(snap);
      expect(isSqliteFile(bytes)).toBe(true);
      stageRestore(dir, bytes);
      expect(applyPendingRestore(dir)).toBe(true);

      const restored = openDatabase(live);
      const row = restored.prepare("SELECT username FROM users WHERE id = ?").get("u1") as
        { username: string } | undefined;
      restored.close();
      expect(row?.username).toBe("ada");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a file that is not our database", () => {
    const dir = mkdtempSync(join(tmpdir(), "unpanel-bak-"));
    try {
      expect(() => stageRestore(dir, Buffer.from("not a database"))).toThrow(/SQLite/);
      writeFileSync(join(dir, "empty.db"), Buffer.from("SQLite format 3\0"));
      expect(() => stageRestore(dir, readFileSync(join(dir, "empty.db")))).toThrow(/readable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the download with a UTC date", () => {
    expect(backupFilename(new Date("2026-10-02T01:02:03Z"))).toBe("unpanel-20261002.db");
  });

  it("does nothing when no restore is pending", () => {
    const dir = mkdtempSync(join(tmpdir(), "unpanel-bak-"));
    try {
      expect(applyPendingRestore(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the pending name stable so a restart can find it", () => {
    expect(PENDING_RESTORE).toBe("pending-restore.db");
  });
});
