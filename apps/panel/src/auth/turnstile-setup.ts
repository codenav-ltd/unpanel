// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createHash, randomBytes } from "node:crypto";
import { LoginSecurityError } from "./security.ts";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const fingerprint = (siteKey: string, secret: string): string =>
  digest(JSON.stringify([siteKey, secret]));
const LIFETIME = 5 * 60_000;

/** A successful browser test authorizes only these keys, in this session, briefly. */
export function createTurnstileSetup(now: () => number = Date.now) {
  const proofs = new Map<
    string,
    { verification: string; fingerprint: string; expiresAt: number }
  >();
  return {
    issue(
      session: string,
      siteKey: string,
      secret: string,
    ): { verification: string; expiresAt: number } {
      for (const [key, value] of proofs) if (value.expiresAt <= now()) proofs.delete(key);
      const key = digest(session);
      proofs.delete(key);
      if (proofs.size >= 128) proofs.delete(proofs.keys().next().value ?? "");
      const proof = {
        verification: randomBytes(32).toString("base64url"),
        fingerprint: fingerprint(siteKey, secret),
        expiresAt: now() + LIFETIME,
      };
      proofs.set(key, proof);
      return { verification: proof.verification, expiresAt: proof.expiresAt };
    },
    require(session: string, siteKey: string, secret: string, verification: unknown): void {
      const proof = proofs.get(digest(session));
      if (
        !proof ||
        proof.expiresAt <= now() ||
        proof.verification !== verification ||
        proof.fingerprint !== fingerprint(siteKey, secret)
      )
        throw new LoginSecurityError(
          "Test these Turnstile keys in the setup guide before enabling them. Tests expire after five minutes; changes to either key require a new test.",
        );
    },
    consume(session: string): void {
      proofs.delete(digest(session));
    },
  };
}
