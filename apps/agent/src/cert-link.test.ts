// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import {
  closeCode,
  decodeTextFrame,
  encodeTextFrame,
  PROTOCOL_VERSION,
  signMessage,
  welcomeMessage,
} from "@unpanel/protocol";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { connectAgent } from "./session.ts";
import { collectHostInfo } from "./host-info.ts";

it("refuses certificate requests before verifying the panel identity", async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  let answered = false;
  const closed = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Unverified request was not refused")), 2000);
    wss.once("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = decodeTextFrame(String(data));
        if (frame.t === "res") answered = true;
        if (frame.t === "hello")
          socket.send(
            encodeTextFrame({
              t: "req",
              id: 1,
              m: "cert.http01.remove",
              p: { token: "test-token" },
            }),
          );
      });
      socket.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  });
  const agent = connectAgent({
    url: `ws://127.0.0.1:${address.port}`,
    agentKey: generateKeyPairSync("ed25519").privateKey,
    panelPublicKey: generateKeyPairSync("ed25519").publicKey,
  });
  try {
    expect(await closed).toBe(closeCode.authFailed);
    expect(answered).toBe(false);
  } finally {
    agent.stop();
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("accepts the challenge cleanup command after a signed panel handshake", async () => {
  const panelKey = generateKeyPairSync("ed25519");
  const server = createServer();
  const wss = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const result = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Authenticated command did not finish")), 2000);
    wss.once("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = decodeTextFrame(String(data));
        if (frame.t === "hello")
          socket.send(
            encodeTextFrame({
              t: "welcome",
              proto: PROTOCOL_VERSION,
              panelVer: "test",
              nonceM: "panel-nonce",
              sigM: signMessage(
                welcomeMessage(frame.agentId, frame.nonceA, "panel-nonce"),
                panelKey.privateKey,
              ),
            }),
          );
        if (frame.t === "auth")
          socket.send(
            encodeTextFrame({
              t: "req",
              id: 1,
              m: "cert.http01.remove",
              p: { token: "test-token" },
            }),
          );
        if (frame.t === "res") {
          clearTimeout(timer);
          resolve(frame);
        }
      });
    });
  });
  const agent = connectAgent({
    url: `ws://127.0.0.1:${address.port}`,
    agentKey: generateKeyPairSync("ed25519").privateKey,
    panelPublicKey: panelKey.publicKey,
    hostInfo: collectHostInfo,
  });
  try {
    expect(await result).toMatchObject({ t: "res", id: 1, ok: true, r: { ok: true } });
  } finally {
    agent.stop();
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
