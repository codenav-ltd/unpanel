// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { generateHOTP } from "@oslojs/otp";
import { describe, expect, it } from "vitest";
import { matchTotp } from "./totp.ts";

const rfcSecret = new TextEncoder().encode("12345678901234567890");

describe("totp", () => {
  it("matches the RFC 6238 SHA1 vector and rejects a replay", () => {
    expect(generateHOTP(rfcSecret, 1n, 8)).toBe("94287082");
    expect(matchTotp(rfcSecret, "287082", 59_000, null)).toBe(1);
    expect(matchTotp(rfcSecret, "287082", 59_000, 1)).toBeNull();
  });
});
