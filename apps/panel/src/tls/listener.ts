// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, get } from "node:https";
import { createServer, type Socket } from "node:net";
import { X509Certificate } from "node:crypto";
import type { TlsMaterial } from "./material.ts";

/** Keep the existing panel port while making plain HTTP redirect after HTTPS is verified. */
export function createPanelListener(options: {
  request: (req: IncomingMessage, res: ServerResponse) => void;
  redirectOrigin: () => string | null;
  material: TlsMaterial | null;
}) {
  let current = options.material;
  const http = createHttpServer((req, res) => {
    const origin = options.redirectOrigin();
    if (!origin || req.url === "/api/v1/health") {
      options.request(req, res);
      return;
    }
    // Do not replay a password or a write submitted over plain HTTP.
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(426, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          error: {
            code: "E_FORBIDDEN",
            message: `HTTPS is enabled. Open ${origin} and sign in before making changes.`,
          },
        }),
      );
      return;
    }
    // Strip authority-shaped paths so a request cannot become an open redirect.
    const path = `/${(req.url ?? "/").replace(/^\/+/, "")}`;
    res.writeHead(302, { location: `${origin}${path}`, "cache-control": "no-store" });
    res.end();
  });
  const https = createHttpsServer({ ...(current ?? {}), minVersion: "TLSv1.2" }, options.request);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    const timeout = setTimeout(() => socket.destroy(), 10_000);
    timeout.unref();
    socket.once("data", (chunk) => {
      clearTimeout(timeout);
      socket.pause();
      const target = chunk[0] === 22 ? https : http;
      if (target === https && !current) {
        socket.destroy();
        return;
      }
      if (target === https) socket.unshift(chunk);
      target.emit("connection", socket);
      if (target === http) socket.emit("data", chunk);
      // TLS consumes the buffered ClientHello on its next tick. Resuming the
      // original socket here would discard it before the TLS wrapper reads it.
      if (target === http) socket.resume();
    });
  });
  // Upgrade listeners attached to HTTP also receive old ws:// connections. Refuse
  // them after TLS activation; remote agents need the current wss:// address.
  http.prependListener("upgrade", (_req, socket: Socket) => {
    if (options.redirectOrigin()) socket.destroy();
  });
  async function apply(material: TlsMaterial | null, host: string): Promise<void> {
    const previous = current;
    if (!material) {
      current = null;
      return;
    }
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("The panel listener is not running.");
    const expected = new X509Certificate(material.cert).fingerprint256;
    try {
      https.setSecureContext({ ...material, minVersion: "TLSv1.2" });
      current = material;
      const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
      await new Promise<void>((resolve, reject) => {
        // A self-signed certificate has no public trust chain. For this local
        // probe, verify the exact certificate fingerprint on the new listener.
        const req = get(
          {
            hostname: probeHost,
            port: address.port,
            path: "/api/v1/health",
            rejectUnauthorized: false,
            agent: false,
            timeout: 5000,
          },
          (res) => {
            const peer = (res.socket as import("node:tls").TLSSocket).getPeerCertificate();
            res.resume();
            if (res.statusCode !== 200 || peer.fingerprint256 !== expected) {
              reject(
                new Error(
                  "The HTTPS listener did not serve the expected certificate and a healthy panel.",
                ),
              );
            } else resolve();
          },
        );
        req.on("timeout", () => req.destroy(new Error("The HTTPS health check timed out.")));
        req.on("error", reject);
      });
    } catch (error) {
      current = previous;
      if (previous) https.setSecureContext({ ...previous, minVersion: "TLSv1.2" });
      throw error;
    }
  }
  return {
    server,
    http,
    https,
    apply,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
