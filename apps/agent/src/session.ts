// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createHash, type KeyObject } from "node:crypto";
import net from "node:net";
import { WebSocket } from "ws";
import { product } from "@unpanel/shared";
import {
  authMessage,
  closeCode,
  decodeTextFrame,
  encodeTextFrame,
  PROTOCOL_VERSION,
  randomNonce,
  signMessage,
  systemInfo,
  verifyMessage,
  welcomeMessage,
  type HostInfo,
  type TextFrame,
} from "@unpanel/protocol";

export function connectAgent(options: {
  socketPath: string;
  agentKey: KeyObject;
  panelPublicKey: KeyObject;
  agentId?: string;
  hostInfo?: () => HostInfo;
}): { stop: () => void } {
  const agentId = options.agentId ?? "local";
  const hostInfo =
    options.hostInfo ??
    (() => {
      throw new Error("host info is unavailable");
    });
  let stopped = false;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nonceA = "";

  const connect = (): void => {
    if (stopped) return;
    nonceA = randomNonce();
    socket = new WebSocket("ws://127.0.0.1/_agent/ws", {
      perMessageDeflate: false,
      createConnection: () => net.connect(options.socketPath),
    });
    socket.on("open", () => {
      socket?.send(
        encodeTextFrame({
          t: "hello",
          agentId,
          proto: PROTOCOL_VERSION,
          agentVer: product.version,
          nonceA,
          ts: Math.floor(Date.now() / 1000),
        }),
      );
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      let frame: TextFrame;
      try {
        frame = decodeTextFrame(String(data));
      } catch {
        socket?.close(closeCode.malformed);
        return;
      }
      if (frame.t === "welcome") {
        const valid = verifyMessage(
          welcomeMessage(agentId, nonceA, frame.nonceM),
          frame.sigM,
          options.panelPublicKey,
        );
        if (!valid) {
          socket?.close(closeCode.authFailed);
          return;
        }
        const host = hostInfo();
        socket?.send(
          encodeTextFrame({
            t: "auth",
            sigA: signMessage(authMessage(agentId, frame.nonceM, nonceA), options.agentKey),
            caps: [{ name: "system", version: product.version }],
            policyDigest: createHash("sha256").update("").digest("base64url"),
            host,
          }),
        );
        return;
      }
      if (frame.t === "req" && frame.m === systemInfo.name) {
        try {
          const info = systemInfo.result.parse(hostInfo());
          socket?.send(encodeTextFrame({ t: "res", id: frame.id, ok: true, r: info }));
        } catch (error) {
          socket?.send(
            encodeTextFrame({
              t: "res",
              id: frame.id,
              ok: false,
              e: {
                code: "E_INTERNAL",
                msg: error instanceof Error ? error.message : "system.info failed",
              },
            }),
          );
        }
      }
    });
    socket.on("close", (code) => {
      if (
        stopped ||
        code === closeCode.replaced ||
        code === closeCode.incompatible ||
        code === closeCode.disabled
      ) {
        return;
      }
      timer = setTimeout(connect, 1000);
    });
    socket.on("error", () => {
      socket?.close();
    });
  };

  connect();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    },
  };
}
