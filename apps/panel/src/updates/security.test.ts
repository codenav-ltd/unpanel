// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, it, expect, vi } from "vitest";
import { parseSecurityAdvisories } from "@unpanel/shared";
import { openDatabase } from "../db/open.ts";
import { createUpdateSecurity } from "./security.ts";
import type { ReleaseFile, UpdateView } from "./check.ts";
const HOUR = 3600000;
function fixture() {
  const db = openDatabase(":memory:");
  let at = Date.parse("2026-10-03T00:00:00Z"),
    maintenance = false;
  const advisories = parseSecurityAdvisories([
    {
      id: "TEST-001",
      title: "Fixture vulnerability",
      severity: "critical",
      affected: [{ from: "0.1.0-alpha.1", below: "0.1.0-alpha.26" }],
      fixedVersion: "0.1.0-alpha.26",
      publishedAt: "2026-10-01T00:00:00Z",
    },
  ]);
  const release: ReleaseFile = {
    version: "0.1.0-alpha.26",
    url: "https://github.com/codenav-ltd/unpanel/releases/download/v0.1.0-alpha.26/unpanel.tar.gz",
    sha256: "a".repeat(64),
    notes: "fixture",
    reviewRequired: false,
    advisories,
  };
  let result: UpdateView & { release: ReleaseFile | null } = {
    current: "0.1.0-alpha.25",
    update: { version: release.version, notes: "fixture", changelog: [], reviewRequired: false },
    advisories,
    error: null,
    release,
  };
  const check = vi.fn(async () => result),
    apply = vi.fn(async () => ({ accepted: true as const, version: release.version })),
    notify = vi.fn(() => 1),
    record = vi.fn();
  const make = () =>
    createUpdateSecurity({
      db,
      current: result.current,
      sourceUrl: "https://github.com/codenav-ltd/unpanel",
      now: () => at,
      check,
      apply,
      notify,
      record,
      maintenance: () => maintenance,
    });
  const service = make();
  return {
    db,
    service,
    make,
    check,
    apply,
    notify,
    record,
    release,
    advisories,
    advance: (hours = 1) => {
      at += hours * HOUR;
    },
    at: () => at,
    result: (next: typeof result) => {
      result = next;
    },
    getResult: () => result,
    maintenance: (value: boolean) => {
      maintenance = value;
    },
    enable: () =>
      service.savePolicy({
        criticalAction: "install_after_deadline",
        graceHours: 6,
        notifyChannels: true,
      }),
  };
}
describe("security release policy", () => {
  it("warns when a valid advisory has no compatible package and refuses unrelated GitHub assets", async () => {
    const f = fixture();
    try {
      f.result({
        ...f.getResult(),
        release: null,
        update: null,
        error: "This release has no linux-arm64 package.",
      });
      await f.service.automatic(true);
      expect(f.service.security().advisories).toHaveLength(1);
      expect(f.notify).toHaveBeenCalledOnce();
      expect(f.apply).not.toHaveBeenCalled();
      f.advance();
      f.release.url =
        "https://github.com/someone/else/releases/download/v0.1.0-alpha.26/package.tar.gz";
      f.result({ ...f.getResult(), error: null, release: f.release });
      await f.service.automatic(true);
      expect(f.apply).not.toHaveBeenCalled();
      expect(f.service.security().hold).toContain("this project's GitHub release");
    } finally {
      f.db.close();
    }
  });
  it("coalesces checks, defaults to notifications and persists bounded reminders across restarts", async () => {
    const f = fixture();
    try {
      await Promise.all([f.service.check(), f.service.check(), f.service.automatic(false)]);
      expect(f.check).toHaveBeenCalledOnce();
      expect(f.notify).toHaveBeenCalledOnce();
      expect(f.apply).not.toHaveBeenCalled();
      f.advance();
      await f.service.check();
      expect(f.notify).toHaveBeenCalledOnce();
      f.service.close();
      const restarted = f.make();
      await restarted.check();
      expect(f.notify).toHaveBeenCalledOnce();
      f.advance(24);
      await restarted.check();
      expect(f.notify).toHaveBeenCalledTimes(2);
      restarted.close();
    } finally {
      f.db.close();
    }
  });
  it("waits for owner grace and publisher deadlines, then prevents simultaneous installs", async () => {
    const f = fixture();
    try {
      f.enable();
      const advisory = f.advisories[0];
      if (!advisory) throw Error("fixture");
      advisory.deadline = new Date(f.at() + 8 * HOUR).toISOString().replace(".000Z", "Z");
      await f.service.automatic(false);
      expect(f.service.security().installAt).toBe(f.at() + 8 * HOUR);
      f.advance(7);
      await f.service.automatic(false);
      expect(f.apply).not.toHaveBeenCalled();
      f.advance();
      await Promise.all([f.service.automatic(false), f.service.automatic(false)]);
      expect(f.apply).toHaveBeenCalledOnce();
      await expect(f.service.install(f.release.version)).rejects.toThrow("already running");
    } finally {
      f.db.close();
    }
  });
  it("retains warnings during outages and refuses missing packages, maintenance and manual-review releases", async () => {
    const f = fixture();
    try {
      f.enable();
      await f.service.check();
      f.advance(8);
      f.release.reviewRequired = true;
      await f.service.automatic(true);
      expect(f.service.security().hold).toContain("manual review");
      f.release.reviewRequired = false;
      f.maintenance(true);
      await f.service.automatic(true);
      expect(f.service.security().hold).toContain("maintenance");
      f.maintenance(false);
      f.advance();
      f.result({ ...f.getResult(), update: null, release: null, error: "Network unavailable" });
      await f.service.automatic(true);
      expect(f.service.security().advisories).toHaveLength(1);
      expect(f.service.security().hold).toContain("Network unavailable");
      expect(f.apply).not.toHaveBeenCalled();
      f.advance();
      f.result({ ...f.getResult(), error: null, release: null });
      await f.service.automatic(true);
      expect(f.service.security().hold).toContain("compatible patch");
      expect(f.apply).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
  it("caps attempts across restarts, permits an explicit manual retry and rejects changed target versions", async () => {
    const f = fixture();
    try {
      f.apply.mockRejectedValue(new Error("fixture agent failure"));
      for (let i = 0; i < 3; i++) {
        await f.service.automatic(true);
        f.advance(1.01);
      }
      expect(f.apply).toHaveBeenCalledTimes(3);
      f.service.close();
      const restarted = f.make();
      await restarted.automatic(true);
      expect(f.apply).toHaveBeenCalledTimes(3);
      expect(restarted.security().hold).toContain("three attempts");
      await expect(restarted.install("0.1.0-alpha.27")).rejects.toThrow("offered version changed");
      await expect(restarted.install(f.release.version)).rejects.toThrow("fixture agent failure");
      expect(f.apply).toHaveBeenCalledTimes(4);
      restarted.close();
    } finally {
      f.db.close();
    }
  });
  it("starts a fresh grace period when enabling policy and keeps ordinary automatic updates independent", async () => {
    const f = fixture();
    try {
      await f.service.check();
      f.advance(48);
      f.enable();
      await f.service.automatic(false);
      expect(f.apply).not.toHaveBeenCalled();
      expect(f.service.security().installAt).toBe(f.at() + 6 * HOUR);
      await f.service.automatic(true);
      expect(f.apply).toHaveBeenCalledOnce();
      f.advance(0.1);
      expect(f.service.security().hold).toContain("did not restart");
    } finally {
      f.db.close();
    }
  });
});
