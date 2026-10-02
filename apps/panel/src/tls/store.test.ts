// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/open.ts";
import { createSettings } from "../settings/store.ts";
import { CertificateError, selfSignedCertificate } from "./material.ts";
import { createCertificates, type CertificateIssuer } from "./store.ts";

async function fixture(issue?: CertificateIssuer) {
  const db = openDatabase(":memory:");
  const masterKey = randomBytes(32);
  const settings = createSettings(db);
  settings.setPublicUrl("http://127.0.0.1:28517", "test");
  const material = await selfSignedCertificate("panel.example.com");
  const apply = vi.fn(async () => undefined);
  const record = vi.fn();
  let clock = Date.now();
  const options = {
    db,
    masterKey,
    settings,
    port: () => 28517,
    apply,
    record,
    issue: issue ?? (async () => material),
    now: () => clock,
  };
  const store = createCertificates(options);
  return {
    db,
    store,
    settings,
    material,
    apply,
    record,
    options,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
function firstId(store: ReturnType<typeof createCertificates>): string {
  const first = store.view().certificates[0];
  if (!first) throw new Error("missing certificate");
  return first.id;
}
const request = {
  domain: "panel.example.com",
  email: "admin@example.com",
  termsAgreed: true,
  staging: true,
};

describe("panel certificate lifecycle", () => {
  it("keeps keys encrypted, exposes only metadata, and persists the active certificate", async () => {
    const f = await fixture();
    try {
      await f.store.upload(request.domain, f.material.cert, f.material.key);
      const id = firstId(f.store);
      expect(JSON.stringify(f.store.view())).not.toContain("PRIVATE KEY");
      expect(JSON.stringify(f.db.prepare("SELECT * FROM panel_certificates").all())).not.toContain(
        f.material.key,
      );
      await f.store.activate(id, "https://panel.example.com:28517", "owner");
      expect(f.settings.view().publicUrl).toBe("https://panel.example.com:28517");
      expect(createCertificates(f.options).activeMaterial()).toEqual(f.material);
      expect(() => f.store.remove(id)).toThrow("Apply another certificate");
    } finally {
      f.db.close();
    }
  });
  it("keeps the active certificate and address when verification fails", async () => {
    const f = await fixture();
    try {
      await f.store.upload(request.domain, f.material.cert, f.material.key);
      const id = firstId(f.store);
      await f.store.activate(id, "https://panel.example.com:28517", "owner");
      const second = await selfSignedCertificate("other.example.com");
      await f.store.upload("other.example.com", second.cert, second.key);
      f.apply.mockRejectedValueOnce(new Error("health check failed"));
      await expect(
        f.store.activate(firstId(f.store), "https://other.example.com:28517", "owner"),
      ).rejects.toThrow("health check failed");
      expect(f.store.view().activeId).toBe(id);
      expect(f.store.activeMaterial()).toEqual(f.material);
      expect(f.settings.view().publicUrl).toBe("https://panel.example.com:28517");
      await expect(
        f.store.activate(id, "https://wrong.example.com:28517", "owner"),
      ).rejects.toThrow("does not cover");
      await expect(f.store.activate(id, "https://panel.example.com", "owner")).rejects.toThrow(
        "existing port",
      );
    } finally {
      f.db.close();
    }
  });
  it("runs issuance as a job, prevents races, and renews the active listener with a new key", async () => {
    let release: () => void = () => undefined;
    let slow = true;
    const issue: CertificateIssuer = async (input, account, progress) => {
      if (!account.key) account.saveKey("test-account-key");
      progress("Validating domain");
      if (slow)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return selfSignedCertificate(input.domain);
    };
    const f = await fixture(issue);
    try {
      expect(f.store.issue(request).job.state).toBe("running");
      expect(() => f.store.issue(request)).toThrow("already running");
      await expect(f.store.generate("localhost")).rejects.toThrow("already running");
      release();
      await f.store.settled();
      slow = false;
      const id = firstId(f.store);
      expect(f.store.view().job.state).toBe("success");
      await f.store.activate(id, "https://panel.example.com:28517", "owner");
      const before = f.store.activeMaterial();
      f.store.renew(id);
      await f.store.settled();
      expect(f.store.view().job.state).toBe("success");
      expect(f.store.activeMaterial()?.key).not.toBe(before?.key);
      expect(f.apply).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(f.db.prepare("SELECT * FROM acme_accounts").all())).not.toContain(
        "test-account-key",
      );
    } finally {
      f.db.close();
    }
  });
  it("backs off failed renewals, respects rate limits, and does not replace the active certificate", async () => {
    let fail = false;
    const issue: CertificateIssuer = async (input) => {
      if (fail) throw new CertificateError("CA rate limited", 400, Date.now() + 12 * 3600_000);
      return selfSignedCertificate(input.domain);
    };
    const f = await fixture(issue);
    try {
      f.store.issue(request);
      await f.store.settled();
      const id = firstId(f.store);
      await f.store.activate(id, "https://panel.example.com:28517", "owner");
      const before = f.store.activeMaterial();
      fail = true;
      f.advance(250 * 86400_000);
      f.store.checkRenewals();
      await f.store.settled();
      expect(f.store.view().job.state).toBe("error");
      expect(f.store.activeMaterial()).toEqual(before);
      const next = f.store.view().certificates[0]?.nextAttempt ?? 0;
      expect(next).toBeGreaterThan(Date.now());
      expect(() => f.store.renew(id)).toThrow("next retry time");
      expect(f.record).toHaveBeenCalledWith(
        "certificate.renew",
        "error",
        expect.stringContaining("CA rate limited"),
      );
      f.store.autoRenew(id, false);
      f.advance(48 * 3600_000);
      f.store.checkRenewals();
      expect(f.store.view().certificates[0]?.failures).toBe(1);
    } finally {
      f.db.close();
    }
  });
  it("records interrupted jobs and requires explicit CA terms agreement", async () => {
    const f = await fixture();
    try {
      expect(() => f.store.issue({ ...request, termsAgreed: false })).toThrow(
        "subscriber agreement",
      );
      f.db
        .prepare("UPDATE panel_tls_state SET job_json = ?")
        .run(JSON.stringify({ state: "running", detail: "pending", certificateId: null }));
      expect(createCertificates(f.options).view().job).toMatchObject({
        state: "error",
        detail: expect.stringContaining("interrupted"),
      });
    } finally {
      f.db.close();
    }
  });
  it("preserves disabled automatic renewal after a successful manual renewal", async () => {
    const f = await fixture();
    try {
      f.store.issue(request);
      await f.store.settled();
      const id = firstId(f.store);
      f.store.autoRenew(id, false);
      f.store.renew(id);
      await f.store.settled();
      expect(f.store.view().job.state).toBe("success");
      expect(f.store.view().certificates[0]?.autoRenew).toBe(false);
    } finally {
      f.db.close();
    }
  });
  it("restores the listener when a database transaction cannot start", async () => {
    const f = await fixture();
    try {
      await f.store.upload(request.domain, f.material.cert, f.material.key);
      f.db.exec("BEGIN IMMEDIATE");
      await expect(
        f.store.activate(firstId(f.store), "https://panel.example.com:28517", "owner"),
      ).rejects.toThrow("transaction");
      expect(f.apply).toHaveBeenLastCalledWith(null);
      expect(f.store.view().activeId).toBeNull();
      expect(f.settings.view().publicUrl).toBe("http://127.0.0.1:28517");
      f.db.exec("ROLLBACK");
    } finally {
      f.db.close();
    }
  });
});
