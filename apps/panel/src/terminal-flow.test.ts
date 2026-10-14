// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { binaryKind, decodeBinaryFrame, encodeBinaryFrame } from "@unpanel/protocol";
import { connectAgent } from "../../agent/src/session.ts";
import { loadPty, terminalMethod } from "../../agent/src/term.ts";
import { createGateway, type ServerMessage } from "./http/gateway.ts";
import { terminalStream } from "./http/terminal.ts";
import { createHub } from "./hub.ts";

describe("terminal from browser to shell", () => {
  it("opens a shell on the node, carries input, output and resize, and audits it", async () => {
    const spawn = await loadPty();
    if (!spawn) throw new Error("node-pty did not load; run pnpm install");
    const panelKeys = generateKeyPairSync("ed25519");
    const agentKeys = generateKeyPairSync("ed25519");
    const hub = createHub({
      panelKey: panelKeys.privateKey,
      agentKey: () => agentKeys.publicKey,
      nodeState: () => "active",
      panelVersion: "test",
    });
    const record = vi.fn();
    const gateway = createGateway({
      sessionUser: (token) => (token === "good" ? { id: "u1", username: "alice" } : null),
      tokenFromCookie: (cookie) => /sid=([^;]+)/.exec(cookie ?? "")?.[1] ?? null,
      publicOrigin: () => "",
      methods: new Map([
        [
          "term.open",
          terminalStream({
            access: () => ({ role: "owner", nodeIds: null, locked: false }),
            elevated: () => true,
            audit: { record },
          }),
        ],
      ]),
      openStream: (nodeId, request, callbacks) => hub.openStream(nodeId, request, callbacks),
    });
    const agentSockets = new WebSocketServer({ noServer: true });
    agentSockets.on("connection", (ws) => hub.attach(ws));
    const server = createServer();
    server.on("upgrade", (req, socket, head) => {
      if (req.url === "/_agent/ws")
        agentSockets.handleUpgrade(req, socket, head, (ws) => agentSockets.emit("connection", ws));
      else if (!gateway.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const agent = connectAgent({
      url: `ws://127.0.0.1:${port}/_agent/ws`,
      agentKey: agentKeys.privateKey,
      panelPublicKey: panelKeys.publicKey,
      agentId: "local",
      hostInfo: () => ({
        hostname: "test-host",
        os: { id: "debian", version: "12", pretty: "Debian 12" },
        kernel: "6.1.0",
        arch: "x64",
        cpu: { model: "test", cores: 1, threads: 1 },
        memTotal: 1024,
        bootTime: 0,
        tz: "UTC",
        ips: { v4: [], v6: [] },
      }),
      streams: new Map([
        [
          "term.open",
          terminalMethod({
            policy: { enabled: true, users: ["root"] },
            spawn,
            // Stands in for systemd-run + runuser so the test runs anywhere.
            launcher: {
              command: () => ({
                file: "/bin/sh",
                args: ["-c", 'stty size; read line; stty size; printf "got %s\\n" "$line"; exit 3'],
              }),
              signalScope: () => undefined,
            },
          }),
        ],
      ]),
      capabilities: [{ name: "term", meta: { users: ["root"] } }],
    });
    let browser: WebSocket | undefined;
    try {
      await vi.waitFor(() =>
        expect(hub.live().find((node) => node.id === "local")?.terminalUsers).toEqual(["root"]),
      );
      browser = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
        headers: { origin: `http://127.0.0.1:${port}`, cookie: "sid=good" },
      });
      const socket = browser;
      const messages: ServerMessage[] = [];
      let output = "";
      const ctrl: unknown[] = [];
      socket.on("message", (data, isBinary) => {
        if (!isBinary) {
          messages.push(JSON.parse(String(data)) as ServerMessage);
          return;
        }
        const frame = decodeBinaryFrame(new Uint8Array(data as Buffer));
        if (frame.kind === binaryKind.ctrl)
          ctrl.push(JSON.parse(new TextDecoder().decode(frame.payload)));
        else output += new TextDecoder().decode(frame.payload);
        socket.send(
          JSON.stringify({ op: "scredit", ch: frame.channel, n: frame.payload.byteLength }),
        );
      });
      await new Promise((resolve) => socket.once("open", resolve));
      socket.send(
        JSON.stringify({
          op: "sopen",
          id: 1,
          node: "local",
          m: "term.open",
          p: { user: "root", cols: 100, rows: 30 },
          win: 65536,
        }),
      );
      await vi.waitFor(() => expect(messages[0]).toMatchObject({ op: "ack", id: 1, ok: true }));
      const ack = messages[0];
      if (ack?.op !== "ack" || !ack.ok) throw new Error("not opened");
      await vi.waitFor(() => expect(output).toContain("30 100"));

      const send = (kind: number, text: string) =>
        socket.send(
          encodeBinaryFrame({
            kind: kind as 1,
            channel: ack.ch,
            payload: new TextEncoder().encode(text),
          }),
        );
      send(binaryKind.ctrl, JSON.stringify({ resize: { cols: 132, rows: 43 } }));
      // Let the resize land before the shell reads its next line.
      await new Promise((resolve) => setTimeout(resolve, 100));
      send(binaryKind.data, "hello\r");
      await vi.waitFor(() => expect(messages.at(-1)).toEqual({ op: "sclose", ch: ack.ch }));
      expect(output).toContain("43 132");
      expect(output).toContain("got hello");
      expect(ctrl).toEqual([{ exit: 3 }]);
      await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2));
      expect(
        record.mock.calls.map(([input]) => [input.action, input.target, input.result]),
      ).toEqual([
        ["term.open", "root", "ok"],
        ["term.close", "root", "ok"],
      ]);
    } finally {
      browser?.close();
      agent.stop();
      gateway.close();
      hub.close();
      agentSockets.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
