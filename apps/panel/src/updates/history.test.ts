// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readUpdateHistory } from "./history.ts";

describe("update history", () => {
  it("reads a completed trace and ignores malformed events", () => {
    const root = mkdtempSync(join(tmpdir(), "unpanel-update-history-"));
    try {
      const dir = join(root, "update-history");
      mkdirSync(dir);
      writeFileSync(
        join(dir, "20261006T100000Z-12345678.jsonl"),
        [
          JSON.stringify({
            type: "operation",
            id: "20261006T100000Z-12345678",
            operation: "update",
            from: "0.1.0-alpha.29",
            to: "0.1.0-alpha.30",
            startedAt: "2026-10-06T10:00:00Z",
          }),
          JSON.stringify({ type: "step", name: "download", durationMs: 184, downtime: false }),
          "not json",
          JSON.stringify({ type: "step", name: "ready", durationMs: 692, downtime: true }),
          JSON.stringify({
            type: "result",
            status: "succeeded",
            durationMs: 1000,
            downtimeMs: 700,
          }),
          "",
        ].join("\n"),
      );
      expect(readUpdateHistory(root)).toEqual([
        expect.objectContaining({ status: "succeeded", durationMs: 1000, downtimeMs: 700 }),
      ]);
      expect(readUpdateHistory(root)[0]?.steps).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not follow trace-file symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "unpanel-update-history-"));
    try {
      const dir = join(root, "update-history"),
        target = join(root, "target.jsonl");
      mkdirSync(dir);
      writeFileSync(
        target,
        `${JSON.stringify({ type: "operation", id: "20261006T100000Z-12345678", operation: "update", from: "1.0.0", to: "1.0.1", startedAt: "2026-10-06T10:00:00Z" })}\n`,
      );
      symlinkSync(target, join(dir, "20261006T100000Z-12345678.jsonl"));
      expect(readUpdateHistory(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
