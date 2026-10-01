// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
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
    const dataDir = mkdtempSync(join(tmpdir(), "unpanel-"));
    const started = await startPanel({
      panelKey: panel.privateKey,
      agentPublicKey: agent.publicKey,
      dataDir,
      port: 0,
    });

    try {
      const cookie = await setupOwner(started.port, started.setupToken ?? "");
      const denied = await fetch(`http://127.0.0.1:${started.port}/api/v1/nodes/local`);
      expect(denied.status).toBe(401);
      const info = await scriptedAgent({
        port: started.port,
        agentKey: agent.privateKey,
        panelPublicKey: panel.publicKey,
        cookie,
      });
      expect(info.online).toBe(true);
      expect(info.info).toMatchObject({ hostname: "test-host", arch: "x64" });
      expect(info.error).toBeNull();
      expect(info.cpu).toEqual([0.42]);
      expect(info.sample).toEqual({
        ratio: 0.42,
        memUsed: 512,
        memTotal: 1024,
        cores: [0.2],
        diskUsed: 256,
        diskTotal: 1024,
        swapUsed: null,
        swapTotal: null,
        load1: null,
        load5: null,
        load15: null,
        rxBps: null,
        txBps: null,
        rxTotal: null,
        txTotal: null,
        tcpCount: 12,
        udpCount: 3,
        agentRss: 4096,
        uptime: 90,
      });
      expect(info.trace).toEqual({ cpu: [0.42], mem: [0.5], disk: [0.25], swap: [] });
      expect(info.rates).toEqual({ up: [], down: [], tcp: [12], udp: [3] });
    } finally {
      await started.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("forwards a panel restart to the agent and returns before the unit is acted on", async () => {
    const panel = generateKeyPairSync("ed25519");
    const agent = generateKeyPairSync("ed25519");
    const dataDir = mkdtempSync(join(tmpdir(), "unpanel-"));
    const started = await startPanel({
      panelKey: panel.privateKey,
      agentPublicKey: agent.publicKey,
      dataDir,
      port: 0,
    });
    const nonceA = "nonce-a";
    let socket: WebSocket | undefined;
    try {
      const cookie = await setupOwner(started.port, started.setupToken ?? "");
      socket = new WebSocket(`ws://127.0.0.1:${started.port}/_agent/ws`);
      const ws = socket;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("handshake timed out")), 5000);
        ws.on("error", reject);
        ws.on("open", () => {
          ws.send(
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
        ws.on("message", (data, isBinary) => {
          if (isBinary) return;
          const frame = decodeTextFrame(String(data));
          if (frame.t === "welcome") {
            ws.send(
              encodeTextFrame({
                t: "auth",
                sigA: signMessage(authMessage("local", frame.nonceM, nonceA), agent.privateKey),
                caps: [{ name: "system" }, { name: "control" }],
                policyDigest: "test",
                host: {},
              }),
            );
          }
          if (frame.t === "req" && frame.m === "system.info") {
            ws.send(
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
            resolve();
          }
          if (frame.t === "req" && frame.m === "panel.restart") {
            ws.send(
              encodeTextFrame({
                t: "res",
                id: frame.id,
                ok: true,
                r: { unit: "unpanel.service", action: "restart", delayMs: 250 },
              }),
            );
          }
        });
      });
      const response = await fetch(`http://127.0.0.1:${started.port}/api/v1/nodes/local/restart`, {
        method: "POST",
        headers: { cookie: `unpanel_sid=${cookie}` },
      });
      const body = (await response.json()) as { data: { unit: string; delayMs: number } };
      expect(response.status).toBe(200);
      expect(body.data).toEqual({ unit: "unpanel.service", action: "restart", delayMs: 250 });
    } finally {
      socket?.close();
      await started.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

function scriptedAgent(options: {
  port: number;
  agentKey: KeyObject;
  panelPublicKey: KeyObject;
  cookie: string;
}): Promise<{
  online: boolean;
  info: { hostname: string; arch: string } | null;
  error: string | null;
  cpu: number[];
  trace: { cpu: number[]; mem: number[]; disk: number[]; swap: number[] };
  rates: { up: number[]; down: number[]; tcp: number[]; udp: number[] };
  sample: Record<string, unknown> | null;
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
      if (frame.t === "req" && frame.m === "metrics.cpu") {
        socket.send(
          encodeTextFrame({
            t: "res",
            id: frame.id,
            ok: true,
            r: {
              ratio: 0.42,
              cores: [0.2],
              memUsed: 512,
              memTotal: 1024,
              diskUsed: 256,
              diskTotal: 1024,
              swapUsed: null,
              swapTotal: null,
              load1: null,
              load5: null,
              load15: null,
              rxBps: null,
              txBps: null,
              rxTotal: null,
              txTotal: null,
              tcpCount: 12,
              udpCount: 3,
              agentRss: 4096,
              uptime: 90,
            },
          }),
        );
        return;
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
          void (async () => {
            try {
              const headers = { cookie: `unpanel_sid=${options.cookie}` };
              const first = await fetch(`http://127.0.0.1:${options.port}/api/v1/nodes/local`, {
                headers,
              });
              if (!first.ok) throw new Error(`local node ${first.status}`);
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
              const second = await fetch(`http://127.0.0.1:${options.port}/api/v1/nodes/local`, {
                headers,
              });
              if (!second.ok) throw new Error(`local node ${second.status}`);
              const body: unknown = await second.json();
              resolve(
                body as {
                  online: boolean;
                  info: { hostname: string; arch: string } | null;
                  error: string | null;
                  cpu: number[];
                  trace: { cpu: number[]; mem: number[]; disk: number[]; swap: number[] };
                  rates: { up: number[]; down: number[]; tcp: number[]; udp: number[] };
                  sample: Record<string, unknown> | null;
                },
              );
            } catch (error) {
              reject(error instanceof Error ? error : new Error("local node failed"));
            } finally {
              socket.close();
            }
          })();
        }, 20);
      }
    });
  });
}

async function setupOwner(port: number, token: string): Promise<string> {
  const begin = await fetch(`http://127.0.0.1:${port}/api/v1/setup/begin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, username: "owner", password: "correct-horse" }),
  });
  if (!begin.ok) throw new Error(`setup begin ${begin.status}`);
  const started = (await begin.json()) as {
    ticket: string;
    secret: string;
    recoveryCodes: string[];
  };
  const secret = decodeBase32IgnorePadding(started.secret);
  const code = generateHOTP(secret, BigInt(Math.floor(Date.now() / 1000 / 30)), 6);
  const recovery = started.recoveryCodes[0];
  if (!recovery) throw new Error("missing recovery code");
  const confirm = await fetch(`http://127.0.0.1:${port}/api/v1/setup/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket: started.ticket, code, recoveryCode: recovery }),
  });
  if (!confirm.ok) throw new Error(`setup confirm ${confirm.status}`);
  const setCookie = confirm.headers.get("set-cookie") ?? "";
  const match = /unpanel_sid=([^;]+)/.exec(setCookie);
  const session = match?.[1];
  if (!session) throw new Error("missing session cookie");
  return session;
}
