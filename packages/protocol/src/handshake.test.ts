// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authMessage, signMessage, verifyMessage, welcomeMessage } from "./handshake.ts";
import vectors from "../test-vectors/handshake.json";

function rfcKey(): {
  privateKey: ReturnType<typeof createPrivateKey>;
  publicKey: ReturnType<typeof createPublicKey>;
} {
  const jwk = {
    kty: "OKP",
    crv: "Ed25519",
    d: Buffer.from(vectors.secretKeyHex, "hex").toString("base64url"),
    x: Buffer.from(vectors.publicKeyHex, "hex").toString("base64url"),
  };
  return {
    privateKey: createPrivateKey({ key: jwk, format: "jwk" }),
    publicKey: createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: "jwk" }),
  };
}

describe("handshake messages", () => {
  it("builds the signed welcome and auth strings", () => {
    expect(welcomeMessage("local", "nonce-a", "nonce-m")).toBe(vectors.message);
    expect(authMessage("local", "nonce-m", "nonce-a")).toBe("panel-auth\nlocal\nnonce-m\nnonce-a");
  });

  it("matches the RFC 8032 signature vector", () => {
    const { privateKey, publicKey } = rfcKey();
    expect(signMessage(vectors.message, privateKey)).toBe(vectors.signature);
    expect(verifyMessage(vectors.message, vectors.signature, publicKey)).toBe(true);
    expect(
      verifyMessage("panel-welcome\nother\nnonce-a\nnonce-m", vectors.signature, publicKey),
    ).toBe(false);
  });
});
