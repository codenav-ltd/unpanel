// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { inspectMaterial, normalizeHost, selfSignedCertificate } from "./material.ts";

describe("panel certificate material", () => {
  it("generates certificates covering IPv4, IPv6, and domain SANs", async () => {
    for (const host of ["127.0.0.1", "::1", "panel.example.com"]) {
      const info = inspectMaterial(await selfSignedCertificate(host), host);
      expect(info.selfSigned).toBe(true);
      expect(info.notAfter).toBeGreaterThan(Date.now());
    }
  });
  it("rejects mismatched keys, hostnames, malformed PEM, and expired certificates", async () => {
    const a = await selfSignedCertificate("panel.example.com");
    const b = await selfSignedCertificate("other.example.com");
    expect(() => inspectMaterial({ cert: a.cert, key: b.key })).toThrow("does not match");
    expect(() => inspectMaterial(a, "other.example.com")).toThrow("does not cover");
    expect(() => inspectMaterial(a, undefined, Date.now() + 400 * 86400_000)).toThrow("expired");
    expect(() => inspectMaterial({ cert: "invalid", key: "invalid" })).toThrow("PEM");
  });
  it("validates domain input without allowing URLs or wildcards", () => {
    expect(normalizeHost("Panel.Example.COM.", true)).toBe("panel.example.com");
    for (const bad of [
      "https://panel.example.com",
      "*.example.com",
      "127.0.0.1",
      "example.com:80",
      "-bad.example.com",
      "a..com",
    ]) {
      expect(() => normalizeHost(bad, true)).toThrow();
    }
  });
});
