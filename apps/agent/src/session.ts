// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createHash, type KeyObject } from "node:crypto";
import net from "node:net";
import { WebSocket } from "ws";
import { product } from "@unpanel/shared";
import { ControlUnsupported, controlPanel } from "./control.ts";
import { sampleHost } from "./cpu.ts";
import { SwapRefused, configureSwap } from "./swap.ts";
import { performAgentUpgrade, performUpgrade } from "./upgrade.ts";
import {
  agentUpgrade,
  authMessage,
  closeCode,
  decodeTextFrame,
  encodeTextFrame,
  hostSwap,
  panelRestart,
  panelStop,
  panelUpgrade,
  PROTOCOL_VERSION,
  randomNonce,
  signMessage,
  systemInfo,
  metricsCpu,
  verifyMessage,
  welcomeMessage,
  type ErrorCode,
  type HostInfo,
  type TextFrame,
} from "@unpanel/protocol";

const agentMethods = new Set([
  systemInfo.name,
  metricsCpu.name,
  panelUpgrade.name,
  agentUpgrade.name,
  panelRestart.name,
  panelStop.name,
  hostSwap.name,
]);

function swapCode(error: SwapRefused): ErrorCode {
  if (error.message.startsWith("Choose")) return "E_INVALID_PARAMS";
  if (error.message.includes("already has swap") || error.message.includes("Not enough")) {
    return "E_CONFLICT";
  }
  if (error.message.startsWith("Could not create")) return "E_EXTERNAL";
  return "E_UNSUPPORTED";
}

export function connectAgent(options: {
  socketPath?: string;
  /** `ws://` or `wss://` URL of the panel's `/_agent/ws`. Used by remote nodes. */
  url?: string;
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
    socket = options.url
      ? new WebSocket(options.url, { perMessageDeflate: false })
      : new WebSocket("ws://127.0.0.1/_agent/ws", {
          perMessageDeflate: false,
          createConnection: () => net.connect(options.socketPath ?? ""),
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
            caps: [
              { name: "system", version: product.version },
              {
                name: "control",
                version: product.version,
                meta: { agentUpgrade: true },
              },
            ],
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
      if (frame.t === "req" && frame.m === metricsCpu.name) {
        socket?.send(
          encodeTextFrame({
            t: "res",
            id: frame.id,
            ok: true,
            r: sampleHost(),
          }),
        );
      }
      if (frame.t === "req" && frame.m === panelUpgrade.name) {
        void performUpgrade(frame.p)
          .then((result) => {
            socket?.send(encodeTextFrame({ t: "res", id: frame.id, ok: true, r: result }));
          })
          .catch((error: unknown) => {
            socket?.send(
              encodeTextFrame({
                t: "res",
                id: frame.id,
                ok: false,
                e: {
                  code: error instanceof ControlUnsupported ? "E_UNSUPPORTED" : "E_INTERNAL",
                  msg: error instanceof Error ? error.message : "update failed",
                },
              }),
            );
          });
      }
      if (frame.t === "req" && frame.m === agentUpgrade.name) {
        void performAgentUpgrade(frame.p, { agentId })
          .then((result) => {
            socket?.send(encodeTextFrame({ t: "res", id: frame.id, ok: true, r: result }));
          })
          .catch((error: unknown) => {
            socket?.send(
              encodeTextFrame({
                t: "res",
                id: frame.id,
                ok: false,
                e: {
                  code: error instanceof ControlUnsupported ? "E_UNSUPPORTED" : "E_INTERNAL",
                  msg: error instanceof Error ? error.message : "agent update failed",
                },
              }),
            );
          });
      }
      if (frame.t === "req" && frame.m === hostSwap.name) {
        const parsed = hostSwap.params.safeParse(frame.p);
        if (!parsed.success) {
          socket?.send(
            encodeTextFrame({
              t: "res",
              id: frame.id,
              ok: false,
              e: {
                code: "E_INVALID_PARAMS",
                msg: "Choose 1, 2, 4, or 8 GiB. Nothing was changed.",
              },
            }),
          );
        } else {
          void configureSwap(parsed.data.sizeGib)
            .then((result) => {
              socket?.send(encodeTextFrame({ t: "res", id: frame.id, ok: true, r: result }));
            })
            .catch((error: unknown) => {
              socket?.send(
                encodeTextFrame({
                  t: "res",
                  id: frame.id,
                  ok: false,
                  e: {
                    code: error instanceof SwapRefused ? swapCode(error) : "E_INTERNAL",
                    msg: error instanceof Error ? error.message : "swap failed",
                  },
                }),
              );
            });
        }
      }
      if (frame.t === "req" && !agentMethods.has(frame.m)) {
        socket?.send(
          encodeTextFrame({
            t: "res",
            id: frame.id,
            ok: false,
            e: {
              code: "E_UNSUPPORTED",
              msg: `This agent does not handle ${frame.m}. Update the agent on this machine. Nothing was changed.`,
            },
          }),
        );
      }
      if (frame.t === "req" && (frame.m === panelRestart.name || frame.m === panelStop.name)) {
        const action = frame.m === panelRestart.name ? "restart" : "stop";
        try {
          socket?.send(
            encodeTextFrame({ t: "res", id: frame.id, ok: true, r: controlPanel(action) }),
          );
        } catch (error) {
          socket?.send(
            encodeTextFrame({
              t: "res",
              id: frame.id,
              ok: false,
              e: {
                code: error instanceof ControlUnsupported ? "E_UNSUPPORTED" : "E_INTERNAL",
                msg: error instanceof Error ? error.message : `${action} failed`,
              },
            }),
          );
        }
      }
    });
    socket.on("close", (code) => {
      if (stopped || code === closeCode.replaced || code === closeCode.incompatible) return;
      // A disabled or removed node backs off for an hour instead of reconnecting immediately.
      const delay = code === closeCode.disabled ? 60 * 60 * 1000 : 1000;
      timer = setTimeout(connect, delay);
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
