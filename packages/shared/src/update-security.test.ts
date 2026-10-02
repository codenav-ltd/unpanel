// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { affectedBy, parseSecurityAdvisories, mergeSecurityAdvisories } from "./update-security.ts";
const advisory = {
  id: "TEST-2026-001",
  title: "Fixture advisory",
  severity: "critical",
  affected: [{ from: "0.1.0-alpha.1", below: "0.1.0-alpha.26" }],
  fixedVersion: "0.1.0-alpha.26",
  publishedAt: "2026-10-01T00:00:00Z",
};
describe("security advisory contracts", () => {
  it("bounds merged registries, prioritizes critical warnings and preserves corrected metadata", () => {
    const older = parseSecurityAdvisories(
      Array.from({ length: 64 }, (_, i) => ({ ...advisory, id: `LOW-${i}`, severity: "low" })),
    );
    const newer = parseSecurityAdvisories([
      { ...advisory },
      { ...advisory, id: "LOW-0", title: "Corrected advisory" },
    ]);
    const merged = mergeSecurityAdvisories(older, newer);
    expect(merged).toHaveLength(64);
    expect(merged.slice(0, 2).every((item) => item.severity === "critical")).toBe(true);
    expect(merged.find((item) => item.id === "LOW-0")?.title).toBe("Corrected advisory");
    expect(() => parseSecurityAdvisories(merged)).not.toThrow();
  });
  it("matches numeric prereleases and half-open affected ranges without alerting patched or future versions", () => {
    const parsed = parseSecurityAdvisories([advisory])[0];
    if (!parsed) throw Error("fixture");
    expect(affectedBy("0.1.0-alpha.25", parsed)).toBe(true);
    expect(affectedBy("0.1.0-alpha.26", parsed)).toBe(false);
    expect(affectedBy("0.1.0", parsed)).toBe(false);
    expect(affectedBy("invalid", parsed)).toBe(false);
    expect(affectedBy("0.1.0-alpha.25", parsed, Date.parse("2026-09-01"))).toBe(false);
  });
  it("rejects invalid dates, duplicate IDs, unsafe links, contradictory ranges and unbounded data", () => {
    for (const patch of [
      { url: "javascript:alert(1)" },
      { url: "https://user:password@example.com/" },
      { publishedAt: "2026-02-30T00:00:00Z" },
      { deadline: "2026-09-01T00:00:00Z" },
      { affected: [{ from: "1.0.0", below: "0.1.0" }] },
      { fixedVersion: "0.1.0-alpha.2" },
      { severity: "urgent" },
      { title: "x".repeat(201) },
    ])
      expect(() => parseSecurityAdvisories([{ ...advisory, ...patch }])).toThrow();
    expect(() => parseSecurityAdvisories([advisory, advisory])).toThrow();
    expect(() => parseSecurityAdvisories(Array(65).fill(advisory))).toThrow();
  });
  it("validates the shipped cumulative registry without inventing active vulnerabilities", () => {
    const registry = JSON.parse(
      readFileSync(new URL("../../../releases/security-advisories.json", import.meta.url), "utf8"),
    ) as unknown;
    expect(() => parseSecurityAdvisories(registry)).not.toThrow();
  });
});
