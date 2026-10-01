// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { KeyObject } from "node:crypto";
import { WebSocket } from "ws";
import {
  authMessage,
  clockSkewed,
  closeCode,
  decodeTextFrame,
  encodeTextFrame,
  HANDSHAKE_TIMEOUT_MS,
  protocolCompatible,
  randomNonce,
  signMessage,
  systemInfo,
  verifyMessage,
  welcomeMessage,
  type HostInfo,
  type TextFrame,
} from "@unpanel/protocol";

export interface LocalSnapshot {
  online: boolean;
  info: HostInfo | null;
  error: string | null;
}

export function createHub(options: {
  panelKey: KeyObject;
  agentPublicKey: KeyObject;
  panelVersion: string;
  now?: () => number;
}): {
  attach: (socket: WebSocket) => void;
  snapshot: () => LocalSnapshot;
  close: () => void;
} {
  const now = options.now ?? Date.now;
  let active: WebSocket | null = null;
  let info: HostInfo | null = null;
  let error: string | null = null;

  function snapshot(): LocalSnapshot {
    return {
      online: active?.readyState === WebSocket.OPEN,
      info,
      error,
    };
  }

  function attach(socket: WebSocket): void {
    let phase: "hello" | "auth" | "open" = "hello";
    let agentId = "";
    let nonceA = "";
    const nonceM = randomNonce();
    const timer = setTimeout(() => {
      if (phase !== "open") socket.close(closeCode.authFailed, "handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);

    const fail = (code: number): void => {
      socket.close(code);
    };

    socket.on("message", (data, isBinary) => {
      if (phase === "open" && isBinary) return;
      if (isBinary) {
        fail(closeCode.malformed);
        return;
      }
      let frame: TextFrame;
      try {
        frame = decodeTextFrame(String(data));
      } catch {
        fail(closeCode.malformed);
        return;
      }

      if (phase === "hello") {
        if (frame.t !== "hello") {
          fail(closeCode.malformed);
          return;
        }
        if (!protocolCompatible(frame.proto)) {
          fail(closeCode.incompatible);
          return;
        }
        if (clockSkewed(frame.ts, now())) {
          fail(closeCode.authFailed);
          return;
        }
        agentId = frame.agentId;
        nonceA = frame.nonceA;
        const sigM = signMessage(welcomeMessage(agentId, nonceA, nonceM), options.panelKey);
        socket.send(
          encodeTextFrame({
            t: "welcome",
            proto: "1.0",
            panelVer: options.panelVersion,
            nonceM,
            sigM,
          }),
        );
        phase = "auth";
        return;
      }

      if (phase === "auth") {
        if (frame.t !== "auth") {
          fail(closeCode.malformed);
          return;
        }
        const valid = verifyMessage(
          authMessage(agentId, nonceM, nonceA),
          frame.sigA,
          options.agentPublicKey,
        );
        if (!valid) {
          fail(closeCode.authFailed);
          return;
        }
        if (active && active !== socket) active.close(closeCode.replaced, "replaced");
        active = socket;
        phase = "open";
        clearTimeout(timer);
        socket.send(
          encodeTextFrame({
            t: "ready",
            sessionId: randomNonce(),
            heartbeatSec: 15,
            metricsMode: "idle",
          }),
        );
        socket.send(
          encodeTextFrame({
            t: "req",
            id: 1,
            m: systemInfo.name,
            p: {},
            to: systemInfo.timeoutMs,
          }),
        );
        return;
      }

      if (frame.t === "res" && frame.id === 1) {
        if (!frame.ok) {
          error = frame.e.msg;
          return;
        }
        const parsed = systemInfo.result.safeParse(frame.r);
        if (!parsed.success) {
          error = "system.info result did not match the schema";
          return;
        }
        info = parsed.data;
        error = null;
      }
    });

    socket.on("close", () => {
      clearTimeout(timer);
      if (active === socket) active = null;
    });

    socket.on("error", () => {
      socket.close(closeCode.internal);
    });
  }

  return {
    attach,
    snapshot,
    close() {
      active?.close();
      active = null;
    },
  };
}
