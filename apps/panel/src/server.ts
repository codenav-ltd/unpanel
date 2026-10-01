// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, unlinkSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { product } from "@unpanel/shared";
import { privateKeyFromPem, publicKeyFromPem } from "@unpanel/protocol";
import { WebSocketServer } from "ws";
import { createHub } from "./hub.ts";

export async function startPanel(options: {
  panelKey: KeyObject;
  agentPublicKey: KeyObject;
  host?: string;
  port?: number;
  socketPath?: string;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const hub = createHub({
    panelKey: options.panelKey,
    agentPublicKey: options.agentPublicKey,
    panelVersion: product.version,
  });

  const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method === "GET" && request.url === "/api/dev/local") {
      const body = JSON.stringify(hub.snapshot());
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  };

  const api = createServer(onRequest);
  const sockets = [attachWebSocket(api, hub)];
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 28517;
  await listen(api, port, host);

  let ipc: Server | undefined;
  if (options.socketPath) {
    if (process.platform !== "win32") {
      try {
        unlinkSync(options.socketPath);
      } catch {
        // The previous socket file is already gone.
      }
    }
    ipc = createServer(onRequest);
    sockets.push(attachWebSocket(ipc, hub));
    await listen(ipc, options.socketPath);
  }

  const address = api.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    port: actualPort,
    async close() {
      hub.close();
      for (const socket of sockets) socket.close();
      await closeServer(api);
      if (ipc) await closeServer(ipc);
    },
  };
}

function attachWebSocket(server: Server, hub: ReturnType<typeof createHub>): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: "/_agent/ws",
    perMessageDeflate: false,
    maxPayload: 1024 * 1024,
  });
  wss.on("connection", (socket) => {
    hub.attach(socket);
  });
  return wss;
}

function listen(server: Server, portOrPath: number | string, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const done = (): void => {
      server.off("error", reject);
      resolve();
    };
    if (typeof portOrPath === "string") server.listen(portOrPath, done);
    else server.listen(portOrPath, host, done);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function readPem(envName: string): string {
  const file = process.env[envName];
  if (!file) throw new Error(`${envName} is not set`);
  return readFileSync(file, "utf8");
}

const isEntry = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");

if (isEntry) {
  const port = Number(process.env["UNPANEL_PORT"] ?? 28517);
  startPanel({
    panelKey: privateKeyFromPem(readPem("UNPANEL_PANEL_KEY")),
    agentPublicKey: publicKeyFromPem(readPem("UNPANEL_AGENT_PUB")),
    port,
    ...(process.env["UNPANEL_SOCKET"] ? { socketPath: process.env["UNPANEL_SOCKET"] } : {}),
  })
    .then(({ port: actual }) => {
      process.stdout.write(`${product.name} panel listening on 127.0.0.1:${actual}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "panel failed"}\n`);
      process.exit(1);
    });
}
