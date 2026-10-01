// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  authMessage,
  decodeTextFrame,
  encodeTextFrame,
  PROTOCOL_VERSION,
  signMessage,
} from "@unpanel/protocol";
import { startPanel } from "./server.ts";

describe("local agent link", () => {
  it("completes the handshake and records system.info", async () => {
    const panel = generateKeyPairSync("ed25519");
    const agent = generateKeyPairSync("ed25519");
    const started = await startPanel({
      panelKey: panel.privateKey,
      agentPublicKey: agent.publicKey,
      port: 0,
    });

    try {
      const info = await scriptedAgent({
        port: started.port,
        agentKey: agent.privateKey,
        panelPublicKey: panel.publicKey,
      });
      expect(info.online).toBe(true);
      expect(info.info).toMatchObject({ hostname: "test-host", arch: "x64" });
      expect(info.error).toBeNull();
    } finally {
      await started.close();
    }
  });
});

function scriptedAgent(options: {
  port: number;
  agentKey: KeyObject;
  panelPublicKey: KeyObject;
}): Promise<{
  online: boolean;
  info: { hostname: string; arch: string } | null;
  error: string | null;
}> {
  const nonceA = "nonce-a";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${options.port}/_agent/ws`);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timed out waiting for system.info"));
    }, 5000);
    socket.on("error", reject);
    socket.on("open", () => {
      socket.send(
        encodeTextFrame({
          t: "hello",
          agentId: "local",
          proto: PROTOCOL_VERSION,
          agentVer: "0.0.0",
          nonceA,
          ts: Math.floor(Date.now() / 1000),
        }),
      );
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const frame = decodeTextFrame(String(data));
      if (frame.t === "welcome") {
        socket.send(
          encodeTextFrame({
            t: "auth",
            sigA: signMessage(authMessage("local", frame.nonceM, nonceA), options.agentKey),
            caps: [{ name: "system" }],
            policyDigest: "test",
            host: {},
          }),
        );
      }
      if (frame.t === "req" && frame.m === "system.info") {
        socket.send(
          encodeTextFrame({
            t: "res",
            id: frame.id,
            ok: true,
            r: {
              hostname: "test-host",
              os: { id: "test", version: "1", pretty: "Test OS" },
              kernel: "test",
              arch: "x64",
              cpu: { model: "test", cores: 1, threads: 1 },
              memTotal: 1024,
              bootTime: 0,
              tz: "UTC",
              ips: { v4: [], v6: [] },
            },
          }),
        );
        clearTimeout(timer);
        setTimeout(() => {
          void fetch(`http://127.0.0.1:${options.port}/api/dev/local`)
            .then(async (response) => {
              const body: unknown = await response.json();
              resolve(
                body as {
                  online: boolean;
                  info: { hostname: string; arch: string } | null;
                  error: string | null;
                },
              );
            })
            .catch(reject)
            .finally(() => socket.close());
        }, 20);
      }
    });
  });
}
