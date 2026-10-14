// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  authMessage,
  binaryKind,
  decodeBinaryFrame,
  decodeTextFrame,
  encodeBinaryFrame,
  encodeTextFrame,
  metricsCpu,
  PROTOCOL_VERSION,
  signMessage,
  type TextFrame,
} from "@unpanel/protocol";
import { createHub } from "./hub.ts";

class Peer extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: TextFrame[] = [];
  binary: Uint8Array[] = [];
  pings = 0;

  send(raw: string | Uint8Array): void {
    if (typeof raw === "string") this.sent.push(decodeTextFrame(raw));
    else this.binary.push(raw);
  }

  ping(): void {
    this.pings += 1;
  }

  close(): void {
    this.readyState = WebSocket.CLOSING;
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  receive(frame: TextFrame): void {
    this.emit("message", encodeTextFrame(frame), false);
  }

  requests(method: string): Extract<TextFrame, { t: "req" }>[] {
    return this.sent.filter(
      (frame): frame is Extract<TextFrame, { t: "req" }> => frame.t === "req" && frame.m === method,
    );
  }
}

function fixture() {
  const panel = generateKeyPairSync("ed25519");
  const agent = generateKeyPairSync("ed25519");
  const presence = vi.fn();
  const hub = createHub({
    panelKey: panel.privateKey,
    agentKey: () => agent.publicKey,
    nodeState: () => "active",
    panelVersion: "test",
    onPresence: presence,
  });
  const attach = (caps: string[] = []): Peer => {
    const peer = new Peer();
    hub.attach(peer as unknown as WebSocket);
    peer.receive({
      t: "hello",
      agentId: "local",
      proto: PROTOCOL_VERSION,
      agentVer: "test",
      nonceA: "test-nonce",
      ts: Math.floor(Date.now() / 1000),
    });
    const welcome = peer.sent.find((frame) => frame.t === "welcome");
    if (welcome?.t !== "welcome") throw new Error("Missing welcome");
    peer.receive({
      t: "auth",
      sigA: signMessage(authMessage("local", welcome.nonceM, "test-nonce"), agent.privateKey),
      caps: caps.map((name) => ({ name })),
      policyDigest: "test",
      host: {},
    });
    return peer;
  };
  return { hub, attach, presence };
}

describe("hub streams", () => {
  const callbacks = () => ({ data: vi.fn(), credit: vi.fn(), close: vi.fn() });
  const request = { method: "term.open", capability: "term", window: 1024 };

  it("refuses streams to offline nodes and agents without the capability", async () => {
    const { hub, attach } = fixture();
    try {
      await expect(hub.openStream("local", request, callbacks())).rejects.toMatchObject({
        code: "E_NODE_OFFLINE",
      });
      attach();
      await expect(hub.openStream("local", request, callbacks())).rejects.toMatchObject({
        code: "E_CAPABILITY_MISSING",
      });
    } finally {
      hub.close();
    }
  });

  it("routes agent stream frames and ends streams when the agent disconnects", async () => {
    const { hub, attach } = fixture();
    try {
      const peer = attach(["term"]);
      const cb = callbacks();
      const opening = hub.openStream("local", { ...request, params: { cols: 80 } }, cb);
      const sopen = peer.sent.find((frame) => frame.t === "sopen");
      expect(sopen).toEqual({ t: "sopen", ch: 2, m: "term.open", p: { cols: 80 }, win: 1024 });
      peer.receive({ t: "sack", ch: 2, ok: true, win: 64 });
      const stream = await opening;

      const output = new TextEncoder().encode("$ ");
      peer.emit(
        "message",
        Buffer.from(encodeBinaryFrame({ kind: binaryKind.data, channel: 2, payload: output })),
        true,
      );
      expect(cb.data).toHaveBeenCalledOnce();
      const [kind, payload] = cb.data.mock.calls[0] as [number, Uint8Array];
      expect(kind).toBe(binaryKind.data);
      expect(new TextDecoder().decode(payload)).toBe("$ ");

      expect(stream.write(binaryKind.data, new TextEncoder().encode("ls\r"))).toBe(true);
      expect(decodeBinaryFrame(peer.binary[0] ?? new Uint8Array())).toMatchObject({
        kind: binaryKind.data,
        channel: 2,
      });

      peer.terminate();
      expect(cb.close).toHaveBeenCalledWith(expect.objectContaining({ code: "E_NODE_OFFLINE" }));
    } finally {
      hub.close();
    }
  });

  it("passes an agent refusal on as a HubCallError", async () => {
    const { hub, attach } = fixture();
    try {
      const peer = attach(["term"]);
      const opening = hub.openStream("local", request, callbacks());
      peer.receive({
        t: "sack",
        ch: 2,
        ok: false,
        e: { code: "E_POLICY_DENIED", msg: "Terminals are off on this node." },
      });
      await expect(opening).rejects.toMatchObject({
        code: "E_POLICY_DENIED",
        message: "Terminals are off on this node.",
      });
    } finally {
      hub.close();
    }
  });
});

describe("hub connection lifecycle", () => {
  it("routes Docker results, rejects invalid replies and settles requests on disconnect", async () => {
    const { hub, attach } = fixture();
    try {
      const peer = attach();
      const result = hub.docker("local", "info", {});
      const req = peer.requests("docker.info")[0];
      if (!req) throw new Error("Missing Docker request");
      const info = {
        availability: "ready",
        version: "27.0",
        apiVersion: "1.45",
        composeVersion: null,
        distro: "ubuntu",
        message: "Docker is ready.",
      };
      peer.receive({ t: "res", id: req.id, ok: true, r: info });
      await expect(result).resolves.toEqual(info);
      const malformed = hub.docker("local", "info", {});
      const bad = peer.requests("docker.info")[1];
      if (!bad) throw new Error("Missing Docker request");
      peer.receive({ t: "res", id: bad.id, ok: true, r: {} });
      await expect(malformed).rejects.toMatchObject({ code: "E_EXTERNAL" });
      const interrupted = hub.docker("local", "containers", {});
      peer.terminate();
      await expect(interrupted).rejects.toMatchObject({ code: "E_NODE_OFFLINE" });
    } finally {
      hub.close();
    }
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("retries timed-out metrics without letting a late reply clear the new request", () => {
    const { hub, attach } = fixture();
    try {
      const peer = attach();
      hub.live();
      const first = peer.requests(metricsCpu.name)[0];
      if (!first) throw new Error("Missing metrics request");
      vi.advanceTimersByTime(metricsCpu.timeoutMs);
      hub.live();
      expect(peer.requests(metricsCpu.name)).toHaveLength(2);
      peer.receive({ t: "res", id: first.id, ok: false, e: { code: "E_TIMEOUT", msg: "late" } });
      vi.advanceTimersByTime(2000);
      hub.live();
      expect(peer.requests(metricsCpu.name)).toHaveLength(2);
    } finally {
      hub.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("detects an unresponsive connection while healthy peers answer pings", () => {
    const { hub, attach, presence } = fixture();
    try {
      const peer = attach();
      vi.advanceTimersByTime(15_000);
      expect(peer.pings).toBe(1);
      peer.emit("pong");
      vi.advanceTimersByTime(15_000);
      expect(hub.live()[0]?.online).toBe(true);
      vi.advanceTimersByTime(15_000);
      expect(hub.live()[0]?.online).toBe(false);
      expect(presence).toHaveBeenLastCalledWith("offline", "local");
    } finally {
      hub.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops old calls on replacement, resumes metrics and ignores replaced peer replies", async () => {
    const { hub, attach } = fixture();
    try {
      const old = attach();
      hub.live();
      const pending = hub.control("local", "restart");
      const rejected = expect(pending).rejects.toMatchObject({ code: "E_NODE_OFFLINE" });
      const next = attach();
      await rejected;
      hub.live();
      expect(next.requests(metricsCpu.name)).toHaveLength(1);
      let resolved = false;
      const current = hub.control("local", "restart").then((result) => {
        resolved = true;
        return result;
      });
      const request = next.requests("panel.restart")[0];
      if (!request) throw new Error("Missing restart request");
      const id = request.id;
      const result = { unit: "unpanel.service", action: "restart" as const, delayMs: 250 };
      // Exercise ownership independently of the WebSocket readyState check.
      old.readyState = WebSocket.OPEN;
      old.receive({ t: "res", id, ok: true, r: result });
      old.terminate();
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(hub.live()[0]?.online).toBe(true);
      next.receive({ t: "res", id, ok: true, r: result });
      await expect(current).resolves.toEqual(result);
    } finally {
      hub.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes unauthenticated sockets and clears their handshake deadlines on shutdown", () => {
    const { hub } = fixture();
    const peer = new Peer();
    hub.attach(peer as unknown as WebSocket);
    hub.close();
    expect(peer.readyState).toBe(WebSocket.CLOSED);
    expect(vi.getTimerCount()).toBe(0);
  });
});
