// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomBytes, timingSafeEqual } from "node:crypto";
import { encodeBase32NoPadding } from "@oslojs/encoding";
import { createTOTPKeyURI, generateHOTP } from "@oslojs/otp";
import { product } from "@unpanel/shared";

export const TOTP_PERIOD_SEC = 30;
export const TOTP_DIGITS = 6;

export function totpSecret(): Uint8Array {
  return new Uint8Array(randomBytes(20));
}

export function totpUri(username: string, secret: Uint8Array): string {
  return createTOTPKeyURI(product.name, username, secret, TOTP_PERIOD_SEC, TOTP_DIGITS);
}

export function totpSecretText(secret: Uint8Array): string {
  return encodeBase32NoPadding(secret);
}

/** Returns the matched time step, or null. Steps at or below lastStep are replays. */
export function matchTotp(
  secret: Uint8Array,
  code: string,
  nowMs: number,
  lastStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(nowMs / 1000 / TOTP_PERIOD_SEC);
  for (const candidate of [step - 1, step, step + 1]) {
    if (candidate < 0) continue;
    if (lastStep !== null && candidate <= lastStep) continue;
    const expected = generateHOTP(secret, BigInt(candidate), TOTP_DIGITS);
    if (safeEqual(expected, code)) return candidate;
  }
  return null;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
