// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { createAudit } from "./log.ts";
import { openDatabase } from "../db/open.ts";

describe("audit log", () => {
  it("keeps the chain valid when the panel and recovery writers alternate", () => {
    const db = openDatabase(":memory:"),
      panel = createAudit(db),
      recovery = createAudit(db);
    panel.record({ action: "auth.login", result: "ok" });
    recovery.record({ action: "security.turnstile.disable", result: "ok" });
    panel.record({ action: "auth.login", result: "ok" });
    expect(panel.verify()).toBe(true);
    expect(panel.head()).toBe(recovery.head());
    db.exec("BEGIN IMMEDIATE");
    recovery.record({ action: "auth.factors.reset", result: "ok" });
    db.exec("ROLLBACK");
    panel.record({ action: "auth.logout", result: "ok" });
    expect(panel.verify()).toBe(true);
    expect(panel.list(10)).toHaveLength(4);
    db.close();
  });
  it("chains records and notices an edited row", () => {
    const db = openDatabase(":memory:");
    const audit = createAudit(db);

    const first = audit.record(
      { action: "auth.login", result: "ok", actorKind: "user", actorId: "ada", ip: "127.0.0.1" },
      1_700_000_000_000,
    );
    const second = audit.record(
      { action: "auth.logout", result: "ok", actorKind: "user", actorId: "ada" },
      1_700_000_060_000,
    );

    expect(second.id).toBeGreaterThan(first.id);
    expect(audit.head()).toBe(second.hash);
    expect(audit.verify()).toBe(true);

    db.prepare("UPDATE audit_logs SET action = ? WHERE id = ?").run("auth.setup", first.id);
    expect(audit.verify()).toBe(false);
  });

  it("resumes the chain from the stored head after a restart", () => {
    const db = openDatabase(":memory:");
    const before = createAudit(db).record({ action: "node.online", result: "ok" }, 1_700_000_000);

    const after = createAudit(db);
    expect(after.head()).toBe(before.hash);
    after.record({ action: "node.offline", result: "error" }, 1_700_000_001);
    expect(after.verify()).toBe(true);
  });

  it("keeps secrets out of the stored parameters", () => {
    const audit = createAudit(openDatabase(":memory:"));

    const entry = audit.record({
      action: "auth.login",
      result: "denied",
      params: { username: "ada", password: "correct-horse", nested: { totpCode: "123456" } },
    });

    expect(entry.params).toEqual({
      username: "ada",
      password: "[redacted]",
      nested: { totpCode: "[redacted]" },
    });
    const stored = audit.list(1)[0];
    expect(stored?.params).toEqual(entry.params);
  });

  it("keeps a long failure sentence instead of cutting it to a code", () => {
    const audit = createAudit(openDatabase(":memory:"));
    const detail = `mkswap: ${"permission denied. ".repeat(40)}`;
    const entry = audit.record({
      action: "host.swap",
      result: "error",
      errorCode: "E_EXTERNAL",
      params: { detail },
    });
    expect(entry.params?.["detail"]).toBe(detail);
    expect(audit.list(1)[0]?.params?.["detail"]).toBe(detail);
  });

  it("still caps ordinary parameter text", () => {
    const audit = createAudit(openDatabase(":memory:"));
    const entry = audit.record({
      action: "node.update",
      result: "ok",
      params: { note: "x".repeat(500) },
    });
    expect(entry.params?.["note"]).toBe(`${"x".repeat(200)}…`);
  });

  it("lists the newest records first and caps the limit", () => {
    const audit = createAudit(openDatabase(":memory:"));
    for (let index = 0; index < 5; index += 1) {
      audit.record({ action: `step.${index}`, result: "ok" }, 1_700_000_000_000 + index);
    }

    expect(audit.list(2).map((entry) => entry.action)).toEqual(["step.4", "step.3"]);
    expect(audit.list(500)).toHaveLength(5);
  });
});
