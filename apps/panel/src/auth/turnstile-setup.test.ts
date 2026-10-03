// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { describe, expect, it } from "vitest";
import { createTurnstileSetup } from "./turnstile-setup.ts";

describe("Turnstile setup authorization", () => {
  it("binds the tested pair to the session and consumes authorization after saving", () => {
    const setup = createTurnstileSetup(),
      proof = setup.issue("session", "site", "secret");
    expect(() => setup.require("session", "site", "secret", proof.verification)).not.toThrow();
    for (const [session, site, secret, verification] of [
      ["other", "site", "secret", proof.verification],
      ["session", "different", "secret", proof.verification],
      ["session", "site", "changed", proof.verification],
      ["session", "site", "secret", "guessed"],
    ])
      expect(() => setup.require(session ?? "", site ?? "", secret ?? "", verification)).toThrow(
        /Test these/,
      );
    expect(JSON.stringify(proof)).not.toMatch(/secret|session/);
    setup.consume("session");
    expect(() => setup.require("session", "site", "secret", proof.verification)).toThrow(
      /Test these/,
    );
  });
  it("expires tests, replaces older tests and bounds the stored sessions", () => {
    let now = 1;
    const setup = createTurnstileSetup(() => now),
      first = setup.issue("session", "site", "secret"),
      second = setup.issue("session", "site", "secret");
    expect(() => setup.require("session", "site", "secret", first.verification)).toThrow();
    now = second.expiresAt;
    expect(() => setup.require("session", "site", "secret", second.verification)).toThrow();
    const fresh = setup.issue("first", "site", "secret");
    for (let i = 0; i < 128; i++) setup.issue(`session${i}`, "site", "secret");
    expect(() => setup.require("first", "site", "secret", fresh.verification)).toThrow();
  });
});
