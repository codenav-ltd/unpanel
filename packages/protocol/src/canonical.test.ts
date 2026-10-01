// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { canonicalJSON } from "./canonical.ts";
import vectors from "../test-vectors/canonical.json";

describe("canonicalJSON", () => {
  it("matches the public test vectors", () => {
    for (const item of vectors.cases) {
      expect(canonicalJSON(item.value)).toBe(item.json);
    }
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJSON(Number.NaN)).toThrow(/non-finite/);
  });
});
