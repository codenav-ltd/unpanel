// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

export interface UpdateStep {
  name: string;
  durationMs: number;
  downtime: boolean;
}

export interface UpdateOperation {
  id: string;
  operation: "update" | "downgrade";
  from: string;
  to: string;
  startedAt: string;
  status: "running" | "succeeded" | "rolled-back" | "failed";
  durationMs: number | null;
  downtimeMs: number | null;
  steps: UpdateStep[];
}

const SAFE_ID = /^[A-Za-z0-9-]{8,80}$/;
const SAFE_VERSION = /^[0-9A-Za-z.-]{1,80}$/;
const SAFE_STEP = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_FILE_BYTES = 128 * 1024;

/** Reads updater-owned append-only traces. Invalid or partial lines are ignored. */
export function readUpdateHistory(dataDir: string, limit = 50): UpdateOperation[] {
  const dir = join(dataDir, "update-history");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl") && SAFE_ID.test(name.slice(0, -6)))
    .sort()
    .reverse()
    .slice(0, Math.max(1, Math.min(limit, 50)))
    .flatMap((name) => {
      let fd: number | undefined;
      try {
        fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
        const text = readFileSync(fd, "utf8");
        const rows = text
          .split("\n")
          .filter(Boolean)
          .slice(0, 100)
          .flatMap((line) => {
            try {
              const value: unknown = JSON.parse(line);
              return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
            } catch {
              return [];
            }
          });
        const first = rows[0];
        if (!first || first["type"] !== "operation") return [];
        const id = first["id"],
          from = first["from"],
          to = first["to"],
          startedAt = first["startedAt"],
          operation = first["operation"];
        if (
          typeof id !== "string" ||
          !SAFE_ID.test(id) ||
          id !== name.slice(0, -6) ||
          typeof from !== "string" ||
          !SAFE_VERSION.test(from) ||
          typeof to !== "string" ||
          !SAFE_VERSION.test(to) ||
          typeof startedAt !== "string" ||
          !Number.isFinite(Date.parse(startedAt)) ||
          (operation !== "update" && operation !== "downgrade")
        )
          return [];
        const steps: UpdateStep[] = [];
        let status: UpdateOperation["status"] = "running";
        let durationMs: number | null = null;
        let downtimeMs: number | null = null;
        for (const row of rows.slice(1)) {
          if (row["type"] === "step") {
            const name = row["name"],
              value = row["durationMs"];
            if (
              typeof name === "string" &&
              SAFE_STEP.test(name) &&
              typeof value === "number" &&
              Number.isInteger(value) &&
              value >= 0 &&
              value <= 30 * 60_000
            )
              steps.push({ name, durationMs: value, downtime: row["downtime"] === true });
          } else if (row["type"] === "result") {
            if (["succeeded", "rolled-back", "failed"].includes(String(row["status"])))
              status = row["status"] as UpdateOperation["status"];
            if (validDuration(row["durationMs"])) durationMs = row["durationMs"];
            if (validDuration(row["downtimeMs"])) downtimeMs = row["downtimeMs"];
          }
        }
        return [{ id, operation, from, to, startedAt, status, durationMs, downtimeMs, steps }];
      } catch {
        return [];
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    });
}

function validDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 30 * 60_000;
}
