// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { get } from "node:https";
import { WebSocket, WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { createPanelListener } from "./listener.ts";
import { selfSignedCertificate } from "./material.ts";

function readHttps(port: number, ca: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get({ hostname: "127.0.0.1", port, path: "/api/v1/health", ca, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += String(chunk);
      });
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

it("serves real HTTPS on the existing port, rotates certificates, and rejects plain HTTP writes", async () => {
  let origin: string | null = null;
  const listener = createPanelListener({
    material: null,
    redirectOrigin: () => origin,
    request: (_req, res) => {
      res.writeHead(200);
      res.end('{"ok":true}');
    },
  });
  await new Promise<void>((resolve) => listener.server.listen(0, "127.0.0.1", resolve));
  const address = listener.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const { port } = address;
  const wss = new WebSocketServer({ server: listener.https, path: "/_agent/ws" });
  wss.on("connection", (ws) => ws.send("connected"));
  try {
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    const first = await selfSignedCertificate("127.0.0.1");
    await listener.apply(first, "127.0.0.1");
    origin = `https://127.0.0.1:${port}`;
    expect(await readHttps(port, first.cert)).toBe('{"ok":true}');
    const redirect = await fetch(`http://127.0.0.1:${port}/certificates`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(`${origin}/certificates`);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
          method: "POST",
          body: "secret",
        })
      ).status,
    ).toBe(426);
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status).toBe(200);
    const socket = new WebSocket(`wss://127.0.0.1:${port}/_agent/ws`, { ca: first.cert });
    expect(
      await new Promise<string>((resolve, reject) => {
        socket.once("message", (m) => resolve(String(m)));
        socket.once("error", reject);
      }),
    ).toBe("connected");
    socket.terminate();
    const second = await selfSignedCertificate("127.0.0.1");
    await listener.apply(second, "127.0.0.1");
    expect(await readHttps(port, second.cert)).toBe('{"ok":true}');
    await expect(readHttps(port, first.cert)).rejects.toThrow();
  } finally {
    wss.close();
    await listener.close();
  }
});
