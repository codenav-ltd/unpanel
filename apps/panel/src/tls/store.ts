// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { decryptSecret, encryptSecret } from "../auth/secret.ts";
import { normalizePublicUrl, type Settings } from "../settings/store.ts";
import {
  CertificateError,
  inspectMaterial,
  normalizeHost,
  selfSignedCertificate,
  type TlsMaterial,
} from "./material.ts";

export interface CertificateRecord {
  id: string;
  source: "selfsigned" | "uploaded" | "acme";
  host: string;
  subject: string;
  issuer: string;
  names: string;
  fingerprint: string;
  notBefore: number;
  notAfter: number;
  selfSigned: boolean;
  autoRenew: boolean;
  staging: boolean;
  email: string;
  active: boolean;
  lastError: string | null;
  nextAttempt: number;
  failures: number;
}
export interface CertificateJob {
  state: "idle" | "running" | "success" | "error";
  detail: string;
  certificateId: string | null;
}
export interface CertificateView {
  certificates: CertificateRecord[];
  activeId: string | null;
  publicUrl: string;
  job: CertificateJob;
  port: number;
}
export interface IssueInput {
  domain: string;
  email: string;
  staging: boolean;
  termsAgreed: boolean;
}
export interface CertificateIssuer {
  (
    input: IssueInput,
    account: { key: string; saveKey: (key: string) => void },
    progress: (detail: string) => void,
  ): Promise<TlsMaterial>;
}
interface StoredRow {
  id: string;
  data_json: string;
  material_enc: string;
}

export function createCertificates(options: {
  db: DatabaseSync;
  masterKey: Buffer;
  settings: Settings;
  port: () => number;
  apply: (material: TlsMaterial | null) => Promise<void>;
  issue: CertificateIssuer;
  record: (action: string, result: "ok" | "error", detail: string) => void;
  now?: () => number;
}) {
  const { db, settings, masterKey } = options;
  const now = options.now ?? Date.now;
  let busy = false;
  let task: Promise<void> | undefined;
  db.exec(`
    CREATE TABLE IF NOT EXISTS panel_certificates (
      id TEXT PRIMARY KEY, data_json TEXT NOT NULL, material_enc TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS panel_tls_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), active_id TEXT,
      previous_id TEXT, job_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS acme_accounts (
      directory TEXT PRIMARY KEY, key_enc TEXT NOT NULL
    );
    INSERT OR IGNORE INTO panel_tls_state VALUES (1, NULL, NULL,
      '{"state":"idle","detail":"","certificateId":null}');
  `);
  function job(): CertificateJob {
    return JSON.parse(
      (
        db.prepare("SELECT job_json FROM panel_tls_state WHERE id = 1").get() as {
          job_json: string;
        }
      ).job_json,
    ) as CertificateJob;
  }
  function setJob(value: CertificateJob): void {
    db.prepare("UPDATE panel_tls_state SET job_json = ? WHERE id = 1").run(JSON.stringify(value));
  }
  if (job().state === "running") {
    setJob({
      state: "error",
      detail:
        "Certificate work was interrupted by a panel restart. Check the saved certificates and Logs before retrying; a certificate may already have been stored.",
      certificateId: null,
    });
  }
  function activeId(): string | null {
    return (
      db.prepare("SELECT active_id FROM panel_tls_state WHERE id = 1").get() as {
        active_id: string | null;
      }
    ).active_id;
  }
  function read(id: string): { record: CertificateRecord; material: TlsMaterial } {
    const row = db.prepare("SELECT * FROM panel_certificates WHERE id = ?").get(id) as
      StoredRow | undefined;
    if (!row) throw new CertificateError("This certificate no longer exists.", 404);
    return {
      record: { ...(JSON.parse(row.data_json) as CertificateRecord), active: activeId() === id },
      material: JSON.parse(
        Buffer.from(decryptSecret(row.material_enc, masterKey)).toString("utf8"),
      ) as TlsMaterial,
    };
  }
  function save(record: CertificateRecord, material: TlsMaterial): void {
    db.prepare(
      `INSERT INTO panel_certificates VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, material_enc = excluded.material_enc`,
    ).run(
      record.id,
      JSON.stringify(record),
      encryptSecret(Buffer.from(JSON.stringify(material)), masterKey),
    );
  }
  function view(): CertificateView {
    const active = activeId();
    const rows = db
      .prepare("SELECT id, data_json FROM panel_certificates ORDER BY rowid DESC")
      .all() as { id: string; data_json: string }[];
    return {
      certificates: rows.map((row) => ({
        ...(JSON.parse(row.data_json) as CertificateRecord),
        active: active === row.id,
      })),
      activeId: active,
      publicUrl: settings.view().publicUrl,
      job: job(),
      port: options.port(),
    };
  }
  function assertIdle(): void {
    if (busy)
      throw new CertificateError(
        "Certificate work is already running. Wait for its result before starting another operation.",
        409,
      );
  }
  function assertCapacity(): void {
    if (view().certificates.length >= 50)
      throw new CertificateError("Remove an unused certificate before adding another.");
  }
  function validatePublicUrl(address: string): string {
    const normalized = normalizePublicUrl(address);
    const id = activeId();
    if (!id) return normalized;
    if (!normalized || new URL(normalized).protocol !== "https:") {
      throw new CertificateError(
        "HTTPS is enabled. Keep an https:// panel address, or apply a different certificate in Certificates.",
      );
    }
    const url = new URL(normalized);
    if (Number(url.port || 443) !== options.port())
      throw new CertificateError(
        `The panel serves HTTPS on port ${options.port()}. Keep that port in its address.`,
      );
    inspectMaterial(read(id).material, normalizeHost(url.hostname), now());
    return normalized;
  }
  async function add(
    material: TlsMaterial,
    source: CertificateRecord["source"],
    host: string,
    input: { email?: string; staging?: boolean; id?: string } = {},
  ): Promise<CertificateRecord> {
    const info = inspectMaterial(material, host, now());
    const record: CertificateRecord = {
      ...info,
      id: input.id ?? randomUUID(),
      source,
      host,
      autoRenew: input.id ? read(input.id).record.autoRenew : source === "acme",
      staging: input.staging ?? false,
      email: input.email ?? "",
      active: false,
      lastError: null,
      nextAttempt: 0,
      failures: 0,
    };
    const previous = activeId() === record.id ? read(record.id) : null;
    if (previous) await options.apply(material);
    try {
      save(record, material);
    } catch (error) {
      if (previous) await options.apply(previous.material);
      throw error;
    }
    return { ...record, active: activeId() === record.id };
  }
  async function generate(host: string): Promise<CertificateView> {
    assertIdle();
    assertCapacity();
    busy = true;
    try {
      const normalized = normalizeHost(host);
      await add(await selfSignedCertificate(normalized), "selfsigned", normalized);
      options.record(
        "certificate.generate",
        "ok",
        "Self-signed certificate created. HTTPS is enabled only after applying it.",
      );
      return view();
    } finally {
      busy = false;
    }
  }
  async function upload(host: string, cert: string, key: string): Promise<CertificateView> {
    assertIdle();
    assertCapacity();
    busy = true;
    try {
      await add({ cert, key }, "uploaded", normalizeHost(host));
      options.record(
        "certificate.import",
        "ok",
        "Certificate chain and matching private key imported.",
      );
      return view();
    } finally {
      busy = false;
    }
  }
  function issue(input: IssueInput, id?: string): CertificateView {
    assertIdle();
    const domain = normalizeHost(input.domain, true);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 254)
      throw new CertificateError("Enter a valid contact email address.");
    if (!input.termsAgreed)
      throw new CertificateError(
        "Accept the Let's Encrypt subscriber agreement before requesting a certificate.",
      );
    if (!id) assertCapacity();
    if (id && read(id).record.nextAttempt > now())
      throw new CertificateError(
        "The previous attempt failed or was rate-limited. Wait until the next retry time shown for this certificate.",
        409,
      );
    busy = true;
    const progress = (detail: string): void =>
      setJob({ state: "running", detail, certificateId: id ?? null });
    progress("Preparing the ACME account and domain validation.");
    task = (async () => {
      try {
        const directory = input.staging ? "letsencrypt-staging" : "letsencrypt-production";
        const row = db
          .prepare("SELECT key_enc FROM acme_accounts WHERE directory = ?")
          .get(directory) as { key_enc: string } | undefined;
        const account = {
          key: row ? Buffer.from(decryptSecret(row.key_enc, masterKey)).toString("utf8") : "",
          saveKey(key: string) {
            db.prepare("INSERT OR REPLACE INTO acme_accounts VALUES (?, ?)").run(
              directory,
              encryptSecret(Buffer.from(key), masterKey),
            );
          },
        };
        const material = await options.issue({ ...input, domain }, account, progress);
        const record = await add(material, "acme", domain, {
          email: input.email,
          staging: input.staging,
          ...(id ? { id } : {}),
        });
        setJob({
          state: "success",
          detail: record.active
            ? "Certificate renewed and verified on the HTTPS listener."
            : "Certificate issued. Review it and apply it to enable HTTPS.",
          certificateId: record.id,
        });
        options.record(
          id ? "certificate.renew" : "certificate.issue",
          "ok",
          `Certificate for ${domain} issued${record.active ? " and applied" : ""}.`,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Certificate issuance failed.";
        setJob({
          state: "error",
          detail: `${detail} The selected certificate was kept. Check DNS, inbound TCP port 80, and Logs before retrying.`,
          certificateId: id ?? null,
        });
        if (id) {
          const previous = read(id);
          const failures = (previous.record.failures ?? 0) + 1;
          const delay = failures === 1 ? 3600_000 : failures === 2 ? 6 * 3600_000 : 24 * 3600_000;
          const nextAttempt = Math.max(
            now() + delay,
            error instanceof CertificateError ? error.retryAt : 0,
          );
          save({ ...previous.record, lastError: detail, nextAttempt, failures }, previous.material);
        }
        options.record(id ? "certificate.renew" : "certificate.issue", "error", job().detail);
      } finally {
        busy = false;
      }
    })();
    return view();
  }
  async function activate(id: string, address: string, actor: string): Promise<CertificateView> {
    assertIdle();
    busy = true;
    const oldId = activeId();
    const oldMaterial = oldId ? read(oldId).material : null;
    try {
      const normalized = normalizePublicUrl(address);
      if (!normalized || new URL(normalized).protocol !== "https:")
        throw new CertificateError("Use an https:// panel address.");
      const url = new URL(normalized);
      if (Number(url.port || 443) !== options.port())
        throw new CertificateError(
          `HTTPS uses the panel's existing port ${options.port()}. Include that port in the address.`,
        );
      const current = read(id);
      inspectMaterial(current.material, normalizeHost(url.hostname), now());
      await options.apply(current.material);
      let transactionStarted = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionStarted = true;
        db.prepare("UPDATE panel_tls_state SET active_id = ?, previous_id = ? WHERE id = 1").run(
          id,
          oldId,
        );
        settings.setPublicUrl(normalized, actor);
        db.exec("COMMIT");
      } catch (error) {
        try {
          if (transactionStarted) db.exec("ROLLBACK");
        } finally {
          await options.apply(oldMaterial);
        }
        throw error;
      }
      options.record(
        "certificate.activate",
        "ok",
        `HTTPS enabled at ${normalized}; the served certificate was verified.`,
      );
      return view();
    } finally {
      busy = false;
    }
  }
  function renew(id: string): CertificateView {
    const { record } = read(id);
    if (record.source !== "acme")
      throw new CertificateError(
        "Only ACME certificates can be renewed here. Import a replacement for this certificate.",
      );
    return issue(
      { domain: record.host, email: record.email, staging: record.staging, termsAgreed: true },
      id,
    );
  }
  function autoRenew(id: string, enabled: boolean): CertificateView {
    assertIdle();
    const current = read(id);
    if (current.record.source !== "acme")
      throw new CertificateError("Automatic renewal requires an ACME certificate.");
    save({ ...current.record, autoRenew: enabled }, current.material);
    options.record(
      "certificate.autoRenew",
      "ok",
      `Automatic renewal ${enabled ? "enabled" : "disabled"} for ${current.record.host}.`,
    );
    return view();
  }
  function remove(id: string): CertificateView {
    assertIdle();
    if (activeId() === id)
      throw new CertificateError("Apply another certificate before removing the active one.", 409);
    read(id);
    db.prepare("DELETE FROM panel_certificates WHERE id = ?").run(id);
    options.record("certificate.remove", "ok", "Unused certificate removed.");
    return view();
  }
  function checkRenewals(): void {
    if (busy) return;
    const due = view().certificates.find(
      (cert) =>
        cert.source === "acme" &&
        cert.autoRenew &&
        cert.nextAttempt <= now() &&
        cert.notAfter - now() <= (cert.notAfter - cert.notBefore) / 3,
    );
    if (due) renew(due.id);
  }
  return {
    view,
    generate,
    upload,
    issue,
    activate,
    renew,
    autoRenew,
    remove,
    checkRenewals,
    validatePublicUrl,
    activeMaterial: () => {
      const id = activeId();
      return id ? read(id).material : null;
    },
    publicCertificate: () => {
      const id = activeId();
      return id ? read(id).material.cert : null;
    },
    settled: async () => {
      await task;
    },
  };
}

export type Certificates = ReturnType<typeof createCertificates>;
