// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { it, expect } from "vitest";
import { defaultSecurityUpdatePolicy, type SecurityUpdateStatus } from "@unpanel/shared";
import { securityPromptKey, shouldPromptSecurity } from "./security-reminder.ts";
it("keeps critical prompts bounded to one hour and renews them when an advisory changes", () => {
  const status: SecurityUpdateStatus = {
    policy: defaultSecurityUpdatePolicy(),
    checkedAt: 100,
    installAt: null,
    hold: null,
    advisories: [
      {
        id: "TEST-001",
        title: "Fixture",
        severity: "critical",
        affected: [],
        fixedVersion: "1.0.1",
        publishedAt: "2026-10-01T00:00:00Z",
      },
    ],
  };
  expect(shouldPromptSecurity(status, null, 100)).toBe(true);
  const saved = { key: securityPromptKey(status), until: 3600100 };
  expect(shouldPromptSecurity(status, saved, 101)).toBe(false);
  expect(shouldPromptSecurity(status, saved, 3600101)).toBe(true);
  expect(shouldPromptSecurity(status, { ...saved, until: 99999999 }, 100)).toBe(true);
  const revised = {
    ...status,
    advisories: status.advisories.map((a) => ({ ...a, title: "Revised impact" })),
  };
  expect(shouldPromptSecurity(revised, saved, 101)).toBe(true);
  expect(
    shouldPromptSecurity(
      { ...status, advisories: status.advisories.map((a) => ({ ...a, severity: "high" })) },
      null,
      100,
    ),
  ).toBe(false);
});
