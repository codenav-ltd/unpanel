// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { passwordProblem, usernameProblem } from "./password.ts";

describe("password policy", () => {
  it("rejects short, common, and username passwords", () => {
    expect(passwordProblem("short", "ada")).toMatch(/10 to 128/);
    expect(passwordProblem("password123", "ada")).toMatch(/common/);
    expect(passwordProblem("ada-lovelace", "ada-lovelace")).toMatch(/username/);
    expect(passwordProblem("correct-horse", "ada")).toBeNull();
  });

  it("rejects usernames outside the allowed set", () => {
    expect(usernameProblem("")).not.toBeNull();
    expect(usernameProblem("ada lovelace")).not.toBeNull();
    expect(usernameProblem("ada")).toBeNull();
  });
});
