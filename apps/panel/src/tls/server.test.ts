// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { expect, it } from "vitest";
import { startPanel } from "../server.ts";

async function tlsCertificate(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/v1/health",
        rejectUnauthorized: false,
        agent: false,
      },
      (res) => {
        const peer = (res.socket as TLSSocket).getPeerCertificate();
        res.resume();
        resolve(peer.fingerprint256);
      },
    ).on("error", reject);
  });
}

it("boots new installations into HTTPS and keeps the same certificate through restart", async () => {
  const options = {
    dataDir: mkdtempSync(join(tmpdir(), "unpanel-tls-restart-")),
    panelKey: generateKeyPairSync("ed25519").privateKey,
    agentPublicKey: generateKeyPairSync("ed25519").publicKey,
    host: "127.0.0.1",
    port: 0,
    tlsDefault: true,
  };
  const first = await startPanel(options);
  const origin = `http://127.0.0.1:${first.port}`;
  let fingerprint: string;
  try {
    const health = (await (await fetch(`${origin}/api/v1/health`)).json()) as {
      tls: { enabled: boolean; fingerprint: string; publicUrl: string };
    };
    expect(health.tls.enabled).toBe(true);
    fingerprint = await tlsCertificate(first.port);
    expect(health.tls.fingerprint).toBe(fingerprint);
    expect(first.publicUrl).toBe(`https://127.0.0.1:${first.port}`);
    const redirect = await fetch(`${origin}/certificates`, { redirect: "manual" });
    expect(redirect.headers.get("location")).toBe(`${first.publicUrl}/certificates`);
  } finally {
    await first.close();
  }
  const restarted = await startPanel({ ...options, port: first.port });
  try {
    expect(await tlsCertificate(restarted.port)).toBe(fingerprint);
    expect(restarted.publicUrl).toBe(first.publicUrl);
  } finally {
    await restarted.close();
  }
});
