// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { Buffer } from "node:buffer";
import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export const CLOCK_SKEW_SEC = 300;
export const HANDSHAKE_TIMEOUT_MS = 10_000;

export const closeCode = {
  malformed: 4400,
  authFailed: 4401,
  disabled: 4403,
  replaced: 4409,
  incompatible: 4426,
  internal: 4500,
} as const;

export function welcomeMessage(agentId: string, nonceA: string, nonceM: string): string {
  return `panel-welcome\n${agentId}\n${nonceA}\n${nonceM}`;
}

export function authMessage(agentId: string, nonceM: string, nonceA: string): string {
  return `panel-auth\n${agentId}\n${nonceM}\n${nonceA}`;
}

export function randomNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function signMessage(message: string, privateKey: KeyObject): string {
  return sign(null, Buffer.from(message), privateKey).toString("base64url");
}

export function verifyMessage(message: string, signature: string, publicKey: KeyObject): boolean {
  try {
    return verify(null, Buffer.from(message), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

export function publicKeyFromPem(pem: string): KeyObject {
  return createPublicKey(pem);
}

/** Protocol major 1 is compatible. Anything else is a 4426 close. */
export function protocolCompatible(proto: string): boolean {
  return proto.split(".")[0] === "1";
}

export function clockSkewed(tsSec: number, nowMs: number): boolean {
  return Math.abs(Math.floor(nowMs / 1000) - tsSec) > CLOCK_SKEW_SEC;
}
