// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { DatabaseSync } from "node:sqlite";
import {
  affectedBy,
  defaultSecurityUpdatePolicy,
  parseSecurityAdvisories,
  mergeSecurityAdvisories,
  severityRank,
  type SecurityAdvisory,
  type SecurityUpdatePolicy,
  type SecurityUpdateStatus,
} from "@unpanel/shared";
import { AccountError } from "../auth/account-error.ts";
import { UpdateError, type ReleaseFile, type UpdateView } from "./check.ts";

const HOUR = 3_600_000,
  DAY = 24 * HOUR;
export function createUpdateSecurity(options: {
  db: DatabaseSync;
  current: string;
  sourceUrl: string;
  now?: () => number;
  check: () => Promise<UpdateView & { release: ReleaseFile | null; catalog?: ReleaseFile[] }>;
  apply: (release: ReleaseFile) => Promise<{ accepted: true; version: string }>;
  maintenance: () => boolean;
  notify: (advisory: SecurityAdvisory, installAt: number | null) => number;
  record: (action: string, result: "ok" | "error", detail: string) => void;
}) {
  const { db, current } = options,
    now = options.now ?? Date.now;
  db.exec(`CREATE TABLE IF NOT EXISTS update_security_policy (id INTEGER PRIMARY KEY CHECK(id=1),action TEXT NOT NULL,grace INTEGER NOT NULL,notify INTEGER NOT NULL,enabled_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS update_advisory_receipts (id TEXT PRIMARY KEY,first_seen INTEGER NOT NULL,notified INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS update_attempts (version TEXT PRIMARY KEY,window_at INTEGER NOT NULL,count INTEGER NOT NULL,last_at INTEGER NOT NULL,error TEXT);
    CREATE TABLE IF NOT EXISTS update_last_check (id INTEGER PRIMARY KEY CHECK(id=1),current TEXT NOT NULL,result TEXT NOT NULL,checked_at INTEGER NOT NULL);`);
  let last: UpdateView = { current, update: null, versions: [], error: null },
    checkedAt: number | null = null,
    cachedAt = 0,
    release: ReleaseFile | null = null,
    catalog: ReleaseFile[] = [],
    checking: Promise<UpdateView> | null = null,
    installing = false,
    acceptedAt = 0,
    installingVersion = "",
    closed = false;
  function officialAsset(target: ReleaseFile): boolean {
    try {
      const source = new URL(options.sourceUrl),
        asset = new URL(target.url),
        repository = source.pathname.replace(/\/$/, "").replace(/\.git$/, "");
      return (
        source.protocol === "https:" &&
        source.hostname === "github.com" &&
        asset.origin === source.origin &&
        !asset.username &&
        !asset.password &&
        !asset.search &&
        !asset.hash &&
        asset.pathname.startsWith(repository + "/releases/download/v" + target.version + "/")
      );
    } catch {
      return false;
    }
  }
  function settleStalled(): void {
    if (installing && acceptedAt && now() - acceptedAt >= 5 * 60_000) {
      installing = false;
      acceptedAt = 0;
      if (installingVersion)
        db.prepare("UPDATE update_attempts SET error=? WHERE version=?").run(
          "The panel did not restart after the update request. Check Logs before retrying.",
          installingVersion,
        );
      if (!closed)
        options.record(
          "update.install",
          "error",
          "The panel did not restart within five minutes of the accepted update request.",
        );
    }
  }
  const saved = db
    .prepare("SELECT result,checked_at FROM update_last_check WHERE id=1 AND current=?")
    .get(current) as { result: string; checked_at: number } | undefined;
  if (saved)
    try {
      const stored = JSON.parse(saved.result) as UpdateView;
      last = {
        current,
        update: null,
        error: "Check for updates to refresh saved security information.",
        advisories: parseSecurityAdvisories(stored.advisories),
      };
      checkedAt = saved.checked_at;
    } catch {
      /* A fresh check replaces damaged cached data. It never authorizes an install. */
    }
  function policy(): SecurityUpdatePolicy {
    const row = db
      .prepare("SELECT action,grace,notify FROM update_security_policy WHERE id=1")
      .get();
    if (!row) return defaultSecurityUpdatePolicy();
    return {
      criticalAction:
        row["action"] === "install_after_deadline" ? "install_after_deadline" : "notify",
      graceHours: row["grace"] === 6 ? 6 : row["grace"] === 72 ? 72 : 24,
      notifyChannels: row["notify"] === 1,
    };
  }
  function firstSeen(advisory: SecurityAdvisory): number {
    return Number(
      db
        .prepare("SELECT first_seen FROM update_advisory_receipts WHERE id=?")
        .get(current + ":" + advisory.id)?.["first_seen"] ?? now(),
    );
  }
  function security(): SecurityUpdateStatus {
    settleStalled();
    const value = policy(),
      advisories = (last.advisories ?? [])
        .filter((item) => affectedBy(current, item, now()))
        .sort((a, b) => severityRank[b.severity] - severityRank[a.severity]);
    const enabledAt = Number(
      db.prepare("SELECT enabled_at FROM update_security_policy WHERE id=1").get()?.[
        "enabled_at"
      ] ?? now(),
    );
    const deadlines =
      value.criticalAction === "install_after_deadline"
        ? advisories
            .filter((item) => item.severity === "critical")
            .map((item) =>
              Math.max(
                Math.max(firstSeen(item), enabledAt) + value.graceHours * HOUR,
                item.deadline ? Date.parse(item.deadline) : 0,
              ),
            )
        : [];
    const installAt = deadlines.length ? Math.min(...deadlines) : null;
    const attempt = release
      ? db
          .prepare("SELECT window_at,count,error FROM update_attempts WHERE version=?")
          .get(release.version)
      : undefined;
    let hold: string | null = null;
    if (installing) hold = "Update requested; waiting for the panel to restart.";
    else if (last.error) hold = "Automatic installation paused: " + last.error;
    else if (!release && advisories.length) hold = "A compatible patch package is not available.";
    else if (release?.reviewRequired)
      hold = "This release needs manual review before installation.";
    else if (release && !officialAsset(release))
      hold =
        "Automatic installation requires an asset from this project's GitHub release. Review the download source and install manually.";
    else if (options.maintenance())
      hold = "The local node is in maintenance; automatic installation is paused.";
    else if (attempt && Number(attempt["window_at"]) > now() - DAY && Number(attempt["count"]) >= 3)
      hold =
        "Automatic installation paused after three attempts in 24 hours. Review logs and update manually.";
    else if (attempt?.["error"]) hold = String(attempt["error"]);
    return { advisories, policy: value, checkedAt, installAt, hold };
  }
  const view = (): UpdateView => ({
    current,
    update: last.update,
    error: last.error,
    versions: last.versions ?? [],
    security: security(),
  });
  async function check(): Promise<UpdateView> {
    if (closed) return last;
    if (checking) return checking;
    if (cachedAt && now() - cachedAt < 60_000) return view();
    checking = (async () => {
      let found: UpdateView & { release: ReleaseFile | null; catalog?: ReleaseFile[] };
      try {
        found = await options.check();
      } catch {
        found = {
          current,
          update: null,
          versions: [],
          error: "Could not check for updates.",
          release: null,
          catalog: [],
        };
      }
      if (closed) return last;
      checkedAt = now();
      cachedAt = now();
      release = found.error ? null : found.release;
      catalog = found.error ? [] : (found.catalog ?? (found.release ? [found.release] : []));
      last = {
        current,
        update: found.error ? last.update : found.update,
        versions: found.error ? (last.versions ?? []) : (found.versions ?? []),
        error: found.error,
        advisories: mergeSecurityAdvisories(
          found.error ? (last.advisories ?? []) : [],
          found.advisories ?? [],
        ),
      };
      for (const advisory of last.advisories ?? [])
        db.prepare(
          "INSERT OR IGNORE INTO update_advisory_receipts(id,first_seen) VALUES (?,?)",
        ).run(current + ":" + advisory.id, now());
      db.prepare(
        "INSERT INTO update_last_check VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET current=excluded.current,result=excluded.result,checked_at=excluded.checked_at",
      ).run(current, JSON.stringify(last), checkedAt);
      db.prepare("DELETE FROM update_advisory_receipts WHERE id NOT LIKE ?").run(current + ":%");
      db.prepare("DELETE FROM update_attempts WHERE window_at<?").run(now() - 7 * DAY);
      const status = security();
      if ((!found.error || found.advisories?.length) && status.policy.notifyChannels)
        for (const advisory of status.advisories) {
          if (severityRank[advisory.severity] < 2) continue;
          const key = current + ":" + advisory.id,
            notified = Number(
              db.prepare("SELECT notified FROM update_advisory_receipts WHERE id=?").get(key)?.[
                "notified"
              ] ?? 0,
            );
          if (notified && now() - notified < DAY) continue;
          try {
            if (options.notify(advisory, status.installAt) > 0)
              db.prepare("UPDATE update_advisory_receipts SET notified=? WHERE id=?").run(
                now(),
                key,
              );
          } catch {
            options.record(
              "update.notify",
              "error",
              "Security update notification could not be queued. Check notification channels.",
            );
          }
        }
      return view();
    })().finally(() => {
      checking = null;
    });
    return checking;
  }
  async function install(
    expectedVersion?: string,
    automatic = false,
  ): Promise<{ accepted: true; version: string }> {
    settleStalled();
    if (installing)
      throw new UpdateError(
        "E_CONFLICT",
        "An update is already running. Wait for the panel to restart.",
      );
    await check();
    if (closed || installing)
      throw new UpdateError("E_CONFLICT", "An update is already running or the panel is stopping.");
    if (expectedVersion === current)
      throw new UpdateError("E_CONFLICT", "This panel is already running the selected version.");
    if (
      expectedVersion &&
      expectedVersion !== release?.version &&
      !catalog.some((item) => item.version === expectedVersion)
    )
      throw new UpdateError(
        "E_CONFLICT",
        "The offered version changed. Review the new release before installing.",
      );
    const requested =
      expectedVersion && expectedVersion !== release?.version
        ? catalog.find((item) => item.version === expectedVersion)
        : release;
    const offered = last.versions?.find((item) => item.version === expectedVersion);
    if (offered && !offered.available)
      throw new UpdateError(
        "E_CONFLICT",
        offered.reason ?? "The selected release is not compatible with this installation.",
      );
    if (!requested || last.error)
      throw new UpdateError(
        "E_EXTERNAL",
        last.error ?? "No compatible release package is available.",
      );
    const target = requested;
    if (automatic && !officialAsset(target))
      throw new UpdateError(
        "E_CONFLICT",
        "Automatic installation requires an official project release asset.",
      );
    if (expectedVersion && expectedVersion !== target.version)
      throw new UpdateError(
        "E_CONFLICT",
        "The offered version changed. Review the new release before installing.",
      );
    if (target.reviewRequired && (automatic || !expectedVersion))
      throw new UpdateError("E_CONFLICT", "Review this release before installing it.");
    installing = true;
    installingVersion = target.version;
    const prior = db
        .prepare("SELECT window_at,count FROM update_attempts WHERE version=?")
        .get(target.version),
      sameWindow = prior && Number(prior["window_at"]) > now() - DAY;
    db.prepare(
      "INSERT INTO update_attempts VALUES (?,?,?,?,NULL) ON CONFLICT(version) DO UPDATE SET window_at=excluded.window_at,count=excluded.count,last_at=excluded.last_at,error=NULL",
    ).run(
      target.version,
      sameWindow ? Number(prior["window_at"]) : now(),
      sameWindow ? Number(prior["count"]) + 1 : 1,
      now(),
    );
    try {
      const result = await options.apply(target);
      acceptedAt = now();
      if (!closed)
        options.record(
          "update.install",
          "ok",
          `${automatic ? "Automatic" : "Manual"} installation of ${target.version} accepted.`,
        );
      return result;
    } catch (error) {
      installing = false;
      if (!closed) {
        db.prepare("UPDATE update_attempts SET error=? WHERE version=?").run(
          "The last installation failed. Review Logs before retrying.",
          target.version,
        );
        options.record(
          "update.install",
          "error",
          `Installation of ${target.version} failed; the existing update rollback remains available.`,
        );
      }
      throw error;
    }
  }
  return {
    check,
    policy,
    security,
    install,
    savePolicy(input: Record<string, unknown>): SecurityUpdatePolicy {
      if (
        input["criticalAction"] !== "notify" &&
        input["criticalAction"] !== "install_after_deadline"
      )
        throw new AccountError("Choose a critical update policy.");
      if (
        ![6, 24, 72].includes(Number(input["graceHours"])) ||
        typeof input["graceHours"] !== "number" ||
        typeof input["notifyChannels"] !== "boolean"
      )
        throw new AccountError("Choose a grace period and notification preference.");
      const previous = policy(),
        changed =
          previous.criticalAction !== input["criticalAction"] ||
          previous.graceHours !== input["graceHours"],
        enabledAt = changed
          ? now()
          : Number(
              db.prepare("SELECT enabled_at FROM update_security_policy WHERE id=1").get()?.[
                "enabled_at"
              ] ?? now(),
            );
      db.prepare(
        "INSERT INTO update_security_policy VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET action=excluded.action,grace=excluded.grace,notify=excluded.notify,enabled_at=excluded.enabled_at",
      ).run(
        input["criticalAction"],
        input["graceHours"],
        Number(input["notifyChannels"]),
        enabledAt,
      );
      return policy();
    },
    async automatic(autoUpdate: boolean): Promise<void> {
      await check();
      if (
        closed ||
        installing ||
        !release ||
        last.error ||
        release.reviewRequired ||
        options.maintenance()
      )
        return;
      const status = security();
      if (!autoUpdate && (status.installAt === null || now() < status.installAt)) return;
      const prior = db
        .prepare("SELECT window_at,count,last_at FROM update_attempts WHERE version=?")
        .get(release.version);
      if (
        prior &&
        (Number(prior["last_at"]) > now() - HOUR ||
          (Number(prior["window_at"]) > now() - DAY && Number(prior["count"]) >= 3))
      )
        return;
      try {
        await install(release.version, true);
      } catch {
        /* install records failures. A later scheduled check may retry within the daily cap. */
      }
    },
    close(): void {
      closed = true;
    },
  };
}
export type UpdateSecurity = ReturnType<typeof createUpdateSecurity>;
