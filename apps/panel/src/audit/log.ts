// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJSON } from "@unpanel/protocol";

const RETAIN_MS = 180 * 24 * 60 * 60 * 1000;
const GENESIS = "0".repeat(64);
const MAX_LIMIT = 200;
const MAX_TEXT = 200;
/** Logs shows params.detail as the sentence for the row, so it is not cut to a code. */
const MAX_DETAIL = 2_000;
const SECRET_KEY = /pass|secret|token|code|key|otp|recovery|cookie|authorization/i;

export type ActorKind = "user" | "system" | "anonymous";
export type AuditResult = "ok" | "denied" | "error";

export interface AuditInput {
  action: string;
  result: AuditResult;
  actorKind?: ActorKind;
  actorId?: string | null;
  ip?: string;
  nodeId?: string | null;
  target?: string | null;
  params?: Record<string, unknown>;
  errorCode?: string | null;
  durationMs?: number | null;
}

/** What goes into the hash chain. `id` and `hash` are derived, so they stay out. */
interface AuditRecord {
  ts: number;
  actorKind: ActorKind;
  actorId: string | null;
  ip: string | null;
  action: string;
  nodeId: string | null;
  target: string | null;
  params: Record<string, unknown> | null;
  result: AuditResult;
  errorCode: string | null;
  durationMs: number | null;
}

export interface AuditEntry extends AuditRecord {
  id: number;
  hash: string;
}

interface Row {
  id: number | bigint;
  ts: number | bigint;
  actor_kind: string;
  actor_id: string | null;
  ip: string | null;
  action: string;
  node_id: string | null;
  target: string | null;
  params_json: string | null;
  result: string;
  error_code: string | null;
  duration_ms: number | bigint | null;
  prev_hash: string;
  hash: string;
}

export interface Audit {
  record: (input: AuditInput, at?: number) => AuditEntry;
  list: (limit: number) => AuditEntry[];
  head: () => string;
  verify: () => boolean;
}

/**
 * Append-only log with a hash chain, so a row cannot be edited or dropped without
 * breaking the links (design/05 §6). Retention cuts the oldest rows, which also cuts
 * the chain: `verify` trusts the first remaining `prev_hash` and checks from there.
 */
export function createAudit(db: DatabaseSync, now: () => number = Date.now): Audit {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_id TEXT,
      ip TEXT,
      action TEXT NOT NULL,
      node_id TEXT,
      target TEXT,
      params_json TEXT,
      result TEXT NOT NULL,
      error_code TEXT,
      duration_ms INTEGER,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_time ON audit_logs(ts);
    CREATE INDEX IF NOT EXISTS audit_actor ON audit_logs(actor_id, ts);
  `);

  const columns = `id, ts, actor_kind, actor_id, ip, action, node_id, target,
    params_json, result, error_code, duration_ms, prev_hash, hash`;
  const write = db.prepare(
    `INSERT INTO audit_logs (ts, actor_kind, actor_id, ip, action, node_id, target,
       params_json, result, error_code, duration_ms, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const readLast = db.prepare(`SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1`);
  const readLatest = db.prepare(`SELECT ${columns} FROM audit_logs ORDER BY id DESC LIMIT ?`);
  const readAll = db.prepare(`SELECT ${columns} FROM audit_logs ORDER BY id`);
  const prune = db.prepare(`DELETE FROM audit_logs WHERE ts < ?`);

  const head = (): string =>
    String((readLast.get() as { hash?: string } | undefined)?.hash ?? GENESIS);

  return {
    record(input, at) {
      const record: AuditRecord = {
        ts: at ?? now(),
        actorKind: input.actorKind ?? "system",
        actorId: text(input.actorId),
        ip: text(input.ip),
        action: input.action,
        nodeId: text(input.nodeId),
        target: text(input.target),
        params: input.params ? redactParams(input.params) : null,
        result: input.result,
        errorCode: text(input.errorCode),
        durationMs: input.durationMs ?? null,
      };
      // The panel and local recovery CLI share this log. Read the head under a
      // write lock rather than caching it across records from another connection.
      const ownsTransaction = !db.isTransaction;
      if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
      try {
        const prevHash = head();
        const hash = chainHash(prevHash, record);
        const written = write.run(
          record.ts,
          record.actorKind,
          record.actorId,
          record.ip,
          record.action,
          record.nodeId,
          record.target,
          record.params ? canonicalJSON(record.params) : null,
          record.result,
          record.errorCode,
          record.durationMs,
          prevHash,
          hash,
        );
        prune.run(record.ts - RETAIN_MS);
        if (ownsTransaction) db.exec("COMMIT");
        return { id: Number(written.lastInsertRowid), ...record, hash };
      } catch (error) {
        if (ownsTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },

    list(limit) {
      const capped = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
      return readLatest.all(capped).map((raw) => entryOf(raw as unknown as Row));
    },

    head,

    verify() {
      let previous: string | null = null;
      for (const raw of readAll.all()) {
        const row = raw as unknown as Row;
        if (previous !== null && row.prev_hash !== previous) return false;
        if (chainHash(row.prev_hash, recordOf(row)) !== row.hash) return false;
        previous = row.hash;
      }
      return true;
    },
  };
}

function chainHash(prevHash: string, record: AuditRecord): string {
  return createHash("sha256").update(prevHash).update(canonicalJSON(record)).digest("hex");
}

function entryOf(row: Row): AuditEntry {
  return { id: Number(row.id), ...recordOf(row), hash: row.hash };
}

function recordOf(row: Row): AuditRecord {
  return {
    ts: Number(row.ts),
    actorKind: actorKindOf(row.actor_kind),
    actorId: row.actor_id,
    ip: row.ip,
    action: row.action,
    nodeId: row.node_id,
    target: row.target,
    params: row.params_json ? (JSON.parse(row.params_json) as Record<string, unknown>) : null,
    result: resultOf(row.result),
    errorCode: row.error_code,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
  };
}

function actorKindOf(value: string): ActorKind {
  return value === "user" || value === "anonymous" ? value : "system";
}

function resultOf(value: string): AuditResult {
  return value === "ok" || value === "denied" ? value : "error";
}

function text(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return value.slice(0, MAX_TEXT);
}

/** Secrets never reach the log: a key that looks like one is replaced, not shortened. */
export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = SECRET_KEY.test(key)
      ? "[redacted]"
      : redactValue(value, key === "detail" ? MAX_DETAIL : MAX_TEXT);
  }
  return out;
}

function redactValue(value: unknown, maxText: number): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, maxText));
  if (value && typeof value === "object") {
    return redactParams(value as Record<string, unknown>);
  }
  if (typeof value === "string" && value.length > maxText) return `${value.slice(0, maxText)}…`;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}
