// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createHash, randomBytes, type KeyObject } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { publicKeyFromPem } from "@unpanel/protocol";

export const nodeStatuses = ["pending", "active", "disabled"] as const;
export type NodeStatus = (typeof nodeStatuses)[number];

export interface NodeRecord {
  id: string;
  name: string;
  tags: string[];
  maintenance: boolean;
  status: NodeStatus;
  transport: "unix" | "wss";
  hasKey: boolean;
}

export interface CreatedNode {
  node: NodeRecord;
  token: string;
  expiresAt: number;
}

export interface NodeCatalog {
  list: () => NodeRecord[];
  get: (id: string) => NodeRecord | null;
  /** The local agent is trusted from the panel config, not an enrollment token. */
  ensureLocal: (input: {
    agentPk: string;
    name: string;
    tags: string[];
    maintenance: boolean;
  }) => void;
  create: (input: { name: string; tags: string[]; createdBy: string }) => CreatedNode;
  update: (
    id: string,
    patch: { name?: string; tags?: string[]; maintenance?: boolean },
  ) => NodeRecord;
  /** Null when the token is missing, expired, used, or the key is not Ed25519. */
  enroll: (token: string, publicKeyPem: string) => { id: string } | null;
  disable: (id: string) => NodeRecord;
  enable: (id: string) => NodeRecord;
  /** Drops the current key and issues a new one-hour token. The local node has no enrollment key. */
  reenroll: (id: string, createdBy: string) => CreatedNode;
  /** Forgets the node. A later handshake with the same id is rejected as disabled. */
  remove: (id: string) => void;
  publicKey: (id: string) => KeyObject | null;
  state: (id: string) => NodeStatus | "unknown";
}

const TOKEN_TTL_MS = 60 * 60 * 1000;

export function createNodes(db: DatabaseSync, now: () => number = Date.now): NodeCatalog {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      agent_pk TEXT,
      transport TEXT NOT NULL,
      maintenance INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS node_tags (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (node_id, tag)
    );
    CREATE TABLE IF NOT EXISTS enrollment_tokens (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS node_revocations (
      id TEXT PRIMARY KEY,
      removed_at INTEGER NOT NULL
    );
  `);

  function tagsOf(id: string): string[] {
    const rows = db.prepare("SELECT tag FROM node_tags WHERE node_id = ? ORDER BY tag").all(id) as {
      tag: string;
    }[];
    return rows.map((row) => row.tag);
  }

  function recordOf(row: {
    id: string;
    name: string;
    status: string;
    agent_pk: string | null;
    transport: string;
    maintenance: number;
  }): NodeRecord {
    return {
      id: row.id,
      name: row.name,
      tags: tagsOf(row.id),
      maintenance: row.maintenance === 1,
      status: row.status === "pending" || row.status === "disabled" ? row.status : "active",
      transport: row.transport === "unix" ? "unix" : "wss",
      hasKey: Boolean(row.agent_pk),
    };
  }

  function rowOf(id: string): Parameters<typeof recordOf>[0] | undefined {
    return db
      .prepare("SELECT id, name, status, agent_pk, transport, maintenance FROM nodes WHERE id = ?")
      .get(id) as Parameters<typeof recordOf>[0] | undefined;
  }

  function writeTags(id: string, tags: string[]): void {
    db.prepare("DELETE FROM node_tags WHERE node_id = ?").run(id);
    const insert = db.prepare("INSERT INTO node_tags (node_id, tag) VALUES (?, ?)");
    for (const tag of tags) insert.run(id, tag);
  }

  return {
    list() {
      const rows = db
        .prepare(
          "SELECT id, name, status, agent_pk, transport, maintenance FROM nodes ORDER BY created_at",
        )
        .all() as Parameters<typeof recordOf>[0][];
      return rows.map(recordOf).sort((a, b) => Number(b.id === "local") - Number(a.id === "local"));
    },
    get(id) {
      const row = rowOf(id);
      return row ? recordOf(row) : null;
    },
    ensureLocal(input) {
      if (rowOf("local")) return;
      const at = now();
      db.prepare(
        `INSERT INTO nodes (id, name, status, agent_pk, transport, maintenance, created_at, updated_at)
         VALUES ('local', ?, 'active', ?, 'unix', ?, ?, ?)`,
      ).run(input.name, input.agentPk, input.maintenance ? 1 : 0, at, at);
      writeTags("local", normalizeTags(input.tags));
    },
    create(input) {
      const name = input.name.trim();
      if (!name || name.length > 64) throw new NodesError("Node name must be 1 to 64 characters.");
      const taken = db.prepare("SELECT id FROM nodes WHERE name = ?").get(name);
      if (taken) throw new NodesError("A node with that name already exists.");
      const tags = normalizeTags(input.tags);
      const id = `nd_${randomBytes(9).toString("base64url")}`;
      const token = `pe_${randomBytes(32).toString("base64url")}`;
      const at = now();
      const expiresAt = at + TOKEN_TTL_MS;
      db.exec("BEGIN");
      try {
        db.prepare(
          `INSERT INTO nodes (id, name, status, agent_pk, transport, maintenance, created_at, updated_at)
           VALUES (?, ?, 'pending', NULL, 'wss', 0, ?, ?)`,
        ).run(id, name, at, at);
        writeTags(id, tags);
        db.prepare(
          `INSERT INTO enrollment_tokens (id, node_id, created_by, expires_at, used_at)
           VALUES (?, ?, ?, ?, NULL)`,
        ).run(sha256(token), id, input.createdBy, expiresAt);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const stored = rowOf(id);
      if (!stored) throw new NodesError("Node was not stored.");
      return { node: recordOf(stored), token, expiresAt };
    },
    update(id, patch) {
      const row = rowOf(id);
      if (!row) throw new NodesError("Node not found.");
      const at = now();
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (name.length > 64) throw new NodesError("Node name must be 64 characters or fewer.");
        if (id !== "local" && !name) throw new NodesError("Node name must be 1 to 64 characters.");
        const taken = db.prepare("SELECT id FROM nodes WHERE name = ? AND id <> ?").get(name, id);
        if (taken) throw new NodesError("A node with that name already exists.");
        db.prepare("UPDATE nodes SET name = ?, updated_at = ? WHERE id = ?").run(name, at, id);
      }
      if (patch.maintenance !== undefined) {
        db.prepare("UPDATE nodes SET maintenance = ?, updated_at = ? WHERE id = ?").run(
          patch.maintenance ? 1 : 0,
          at,
          id,
        );
      }
      if (patch.tags !== undefined) writeTags(id, normalizeTags(patch.tags));
      const next = rowOf(id);
      if (!next) throw new NodesError("Node not found.");
      return recordOf(next);
    },
    disable(id) {
      if (!rowOf(id)) throw new NodesError("Node not found.");
      db.prepare("UPDATE nodes SET status = 'disabled', updated_at = ? WHERE id = ?").run(
        now(),
        id,
      );
      const next = rowOf(id);
      if (!next) throw new NodesError("Node not found.");
      return recordOf(next);
    },
    enable(id) {
      const row = rowOf(id);
      if (!row) throw new NodesError("Node not found.");
      const status = row.agent_pk || id === "local" ? "active" : "pending";
      db.prepare("UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
      const next = rowOf(id);
      if (!next) throw new NodesError("Node not found.");
      return recordOf(next);
    },
    reenroll(id, createdBy) {
      if (id === "local") {
        throw new NodesError("The local node uses the panel agent key and cannot be re-enrolled.");
      }
      const row = rowOf(id);
      if (!row) throw new NodesError("Node not found.");
      const at = now();
      const token = `pe_${randomBytes(32).toString("base64url")}`;
      const expiresAt = at + TOKEN_TTL_MS;
      db.exec("BEGIN");
      try {
        db.prepare(
          "UPDATE nodes SET agent_pk = NULL, status = 'pending', updated_at = ? WHERE id = ?",
        ).run(at, id);
        db.prepare(
          "UPDATE enrollment_tokens SET used_at = ? WHERE node_id = ? AND used_at IS NULL",
        ).run(at, id);
        db.prepare(
          `INSERT INTO enrollment_tokens (id, node_id, created_by, expires_at, used_at)
           VALUES (?, ?, ?, ?, NULL)`,
        ).run(sha256(token), id, createdBy, expiresAt);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const stored = rowOf(id);
      if (!stored) throw new NodesError("Node was not stored.");
      return { node: recordOf(stored), token, expiresAt };
    },
    remove(id) {
      if (id === "local") throw new NodesError("The local node cannot be removed.");
      if (!rowOf(id)) throw new NodesError("Node not found.");
      const at = now();
      db.exec("BEGIN");
      try {
        db.prepare(
          "INSERT INTO node_revocations (id, removed_at) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET removed_at = excluded.removed_at",
        ).run(id, at);
        db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    enroll(token, publicKeyPem) {
      const tokenId = sha256(token);
      const row = db
        .prepare(
          `SELECT enrollment_tokens.node_id, enrollment_tokens.expires_at, enrollment_tokens.used_at, nodes.agent_pk
           FROM enrollment_tokens JOIN nodes ON nodes.id = enrollment_tokens.node_id
           WHERE enrollment_tokens.id = ?`,
        )
        .get(tokenId) as
        | { node_id: string; expires_at: number; used_at: number | null; agent_pk: string | null }
        | undefined;
      if (!row || row.used_at !== null || row.expires_at <= now() || row.agent_pk) return null;
      const pem = canonicalKey(publicKeyPem);
      if (!pem) return null;
      const at = now();
      db.prepare("UPDATE enrollment_tokens SET used_at = ? WHERE id = ?").run(at, tokenId);
      db.prepare(
        "UPDATE nodes SET agent_pk = ?, status = 'active', updated_at = ? WHERE id = ?",
      ).run(pem, at, row.node_id);
      return { id: row.node_id };
    },
    publicKey(id) {
      const row = db.prepare("SELECT agent_pk FROM nodes WHERE id = ?").get(id) as
        { agent_pk: string | null } | undefined;
      if (!row?.agent_pk) return null;
      try {
        return publicKeyFromPem(row.agent_pk);
      } catch {
        return null;
      }
    },
    state(id) {
      const row = db.prepare("SELECT status FROM nodes WHERE id = ?").get(id) as
        { status: string } | undefined;
      if (!row) {
        const revoked = db.prepare("SELECT id FROM node_revocations WHERE id = ?").get(id);
        return revoked ? "disabled" : "unknown";
      }
      if (row.status === "pending" || row.status === "disabled") return row.status;
      return "active";
    },
  };
}

export class NodesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodesError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeTags(tags: string[]): string[] {
  if (tags.length > 8) throw new NodesError("Use at most 8 tags.");
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) continue;
    if (tag.length > 32) throw new NodesError("Each tag must be 32 characters or fewer.");
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

function canonicalKey(pem: string): string | null {
  if (pem.length > 4096) return null;
  try {
    const key = publicKeyFromPem(pem);
    if (key.asymmetricKeyType !== "ed25519") return null;
    const exported = key.export({ type: "spki", format: "pem" });
    return typeof exported === "string" ? exported : exported.toString();
  } catch {
    return null;
  }
}
