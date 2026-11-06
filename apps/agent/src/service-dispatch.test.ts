// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import {
  decodeTextFrame,
  encodeTextFrame,
  PROTOCOL_VERSION,
  signMessage,
  welcomeMessage,
  type TextFrame,
} from "@unpanel/protocol";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { collectHostInfo } from "./host-info.ts";
import { createService } from "./service.ts";
import { connectAgent } from "./session.ts";

type Reply = Extract<TextFrame, { t: "res" }>;

/** Connects a real agent session to a scripted panel, sends the requests, and returns the replies. */
async function ask(
  service: ReturnType<typeof createService> | null,
  requests: { m: string; p: unknown }[],
): Promise<Reply[]> {
  const panelKey = generateKeyPairSync("ed25519");
  const server = createServer();
  const wss = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const replies = new Promise<Reply[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The agent did not answer")), 3000);
    const got: Reply[] = [];
    wss.once("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = decodeTextFrame(String(data));
        if (frame.t === "hello") {
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
        }
        if (frame.t === "auth") {
          requests.forEach((request, index) =>
            socket.send(encodeTextFrame({ t: "req", id: index + 1, m: request.m, p: request.p })),
          );
        }
        if (frame.t === "res") {
          got.push(frame);
          if (got.length === requests.length) {
            clearTimeout(timer);
            resolve(got.toSorted((a, b) => Number(a.id) - Number(b.id)));
          }
        }
      });
    });
  });
  const agent = connectAgent({
    url: `ws://127.0.0.1:${address.port}`,
    agentKey: generateKeyPairSync("ed25519").privateKey,
    panelPublicKey: panelKey.publicKey,
    hostInfo: collectHostInfo,
    service,
  });
  try {
    return await replies;
  } finally {
    agent.stop();
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it("answers service.* requests and maps failures to protocol error codes", async () => {
  const calls: string[][] = [];
  const service = createService({
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (args.includes("show") && args.includes("ghost.service")) {
        return { code: 0, stdout: "LoadState=not-found\n", stderr: "" };
      }
      if (args.includes("daemon-reload")) {
        return { code: 1, stdout: "", stderr: "Failed to reload daemon: Connection timed out\n" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const replies = await ask(service, [
    { m: "service.daemonReload", p: {} },
    { m: "service.get", p: { unit: "ghost.service" } },
    { m: "service.action", p: { unit: "sshd.service", action: "stop" } },
    { m: "service.action", p: { unit: "unpanel-agent.service", action: "restart" } },
    { m: "service.get", p: { unit: "--bad" } },
    { m: "service.timers", p: {} },
  ]);
  expect(replies.map((reply) => (reply.ok ? "ok" : reply.e.code))).toEqual([
    "E_EXTERNAL",
    "E_NOT_FOUND",
    "E_PRECONDITION",
    "E_POLICY_DENIED",
    "E_INVALID_PARAMS",
    "ok",
  ]);
  const first = replies[0];
  expect(first && !first.ok ? first.e.msg : "").toContain("Connection timed out");
  expect(replies[5]).toMatchObject({ ok: true, r: { timers: [] } });
  // Neither the guarded stop nor the refused restart reached systemctl.
  expect(calls.some((call) => call.includes("stop") || call.includes("restart"))).toBe(false);
});

it("replies E_CAPABILITY_MISSING on a node without systemd", async () => {
  const replies = await ask(null, [{ m: "service.list", p: {} }]);
  expect(replies[0]).toMatchObject({ ok: false, e: { code: "E_CAPABILITY_MISSING" } });
});
