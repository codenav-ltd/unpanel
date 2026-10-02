// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Hono } from "hono";
import { MAX_BACKUP_BYTES } from "../backup/panel.ts";
import { staticResponse } from "./static.ts";

const MAX_BODY = 64 * 1024;

/** Adapts a Hono app onto the panel's Node HTTP server, including the agent upgrade listener. */
export function handleHttp(
  app: Hono,
  webRoot?: string,
  options: { authorizeBackup?: (cookie: string | undefined) => boolean } = {},
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (request.headers.upgrade?.toLowerCase() === "websocket") return;
    if (webRoot && (request.method === "GET" || request.method === "HEAD")) {
      const served = staticResponse(webRoot, request.method, request.url ?? "/");
      if (served) {
        response.writeHead(served.status, served.headers);
        response.end(request.method === "HEAD" ? undefined : served.body);
        return;
      }
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    const rejectBody = (status: 401 | 413 | 500, code: string, message: string): void => {
      rejected = true;
      chunks.length = 0;
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ error: { code, message } }));
      // Drain without retaining any more bytes so the client receives the error,
      // rather than resetting the TCP connection while it is still uploading.
      request.resume();
    };
    request.on("error", () => {
      chunks.length = 0;
      if (!response.writableEnded) response.destroy();
    });
    let backup = false;
    try {
      backup =
        request.method === "POST" &&
        new URL(request.url ?? "/", "http://panel.local").pathname === "/api/v1/backup/panel";
    } catch {
      // dispatch() reports a malformed URL through the normal error response.
    }
    if (backup) {
      try {
        if (!options.authorizeBackup?.(request.headers.cookie)) {
          rejectBody(401, "E_UNAUTHENTICATED", "Sign in to restore a backup.");
          return;
        }
      } catch {
        rejectBody(
          500,
          "E_INTERNAL",
          "The backup session could not be verified. Open Logs and try again.",
        );
        return;
      }
    }
    const limit = backup ? MAX_BACKUP_BYTES : MAX_BODY;
    const tooLarge = (): void =>
      rejectBody(413, "E_PAYLOAD_TOO_LARGE", `Request body exceeds the ${limit}-byte limit.`);
    if (Number(request.headers["content-length"] ?? 0) > limit) {
      tooLarge();
      return;
    }
    request.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (response.writableEnded) return;
      void dispatch(app, request, response, Buffer.concat(chunks)).catch((error: unknown) => {
        if (response.writableEnded) return;
        const reason = error instanceof Error && error.message ? error.message : "unknown failure";
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        response.end(
          JSON.stringify({
            error: {
              code: "E_INTERNAL",
              message: `The panel failed before it could finish (${reason}). Open Logs.`,
            },
          }),
        );
      });
    });
  };
}

async function dispatch(
  app: Hono,
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer,
): Promise<void> {
  const host = request.headers.host ?? "127.0.0.1";
  const encrypted = "encrypted" in request.socket && request.socket.encrypted;
  const url = new URL(request.url ?? "/", `${encrypted ? "https" : "http"}://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else headers.set(key, value);
  }
  headers.delete("x-unpanel-client-ip");
  headers.set("x-unpanel-client-ip", request.socket.remoteAddress ?? "");
  const method = request.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const incoming = new Request(url, {
    method,
    headers,
    ...(hasBody && body.length > 0 ? { body: new Uint8Array(body) } : {}),
  });
  const outgoing = await app.fetch(incoming);
  response.statusCode = outgoing.status;
  const cookies = outgoing.headers.getSetCookie();
  outgoing.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    response.setHeader(key, value);
  });
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
  response.end(Buffer.from(await outgoing.arrayBuffer()));
}
