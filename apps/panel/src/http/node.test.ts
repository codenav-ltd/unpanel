// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { MAX_BACKUP_BYTES, PENDING_RESTORE } from "../backup/panel.ts";
import { startPanel } from "../server.ts";
import { sessionCookie, sessionTokenFromCookie } from "./api.ts";
import { handleHttp } from "./node.ts";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing port"));
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function upload(
  port: number,
  path: string,
  headers: Record<string, string>,
  chunks?: Buffer[],
): Promise<{ status: number; body: { error: { code: string } } }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      const received: Buffer[] = [];
      res.on("data", (chunk: Buffer) => received.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(received).toString()),
        });
        req.destroy();
      });
    });
    req.on("error", reject);
    req.setTimeout(2000, () =>
      req.destroy(new Error("The body was read before rejecting its headers")),
    );
    req.flushHeaders();
    if (chunks) {
      for (const chunk of chunks) req.write(chunk);
      req.end();
    }
  });
}

describe("HTTP request body boundaries", () => {
  it("restores a real panel export larger than 64 KiB over HTTP", async () => {
    const panelKey = generateKeyPairSync("ed25519");
    const agentKey = generateKeyPairSync("ed25519");
    const dataDir = mkdtempSync(join(tmpdir(), "unpanel-http-backup-"));
    const panel = await startPanel({
      panelKey: panelKey.privateKey,
      agentPublicKey: agentKey.publicKey,
      dataDir,
      port: 0,
    });
    try {
      const base = `http://127.0.0.1:${panel.port}`;
      const setupResponse = await fetch(`${base}/api/v1/setup/begin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: panel.setupToken,
          username: "fixture",
          password: "fixture-password",
        }),
      });
      const setup = (await setupResponse.json()) as { ticket: string };
      const confirmed = await fetch(`${base}/api/v1/setup/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: setup.ticket, totp: false }),
      });
      expect(confirmed.status).toBe(200);
      const cookie = confirmed.headers.get("set-cookie")?.split(";")[0] ?? "";
      const exported = await fetch(`${base}/api/v1/backup/panel`, { headers: { cookie } });
      expect(exported.status).toBe(200);
      const backup = await exported.arrayBuffer();
      expect(backup.byteLength).toBeGreaterThan(64 * 1024);
      const restored = await fetch(`${base}/api/v1/backup/panel`, {
        method: "POST",
        headers: { cookie, "content-type": "application/vnd.sqlite3" },
        body: backup,
      });
      expect(restored.status).toBe(200);
      expect(await restored.json()).toEqual({ data: { status: "pending", restartRequired: true } });
      expect(existsSync(join(dataDir, PENDING_RESTORE))).toBe(true);
    } finally {
      await panel.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects an anonymous large backup before waiting for any upload bytes", async () => {
    const app = new Hono();
    let reachedRoute = false;
    app.post("/api/v1/backup/panel", (c) => {
      reachedRoute = true;
      return c.json({ ok: true });
    });
    const server = createServer(handleHttp(app));
    const port = await listen(server);
    try {
      const response = await upload(port, "/api/v1/backup/panel", {
        "content-length": String(MAX_BACKUP_BYTES),
      });
      expect(response).toEqual({
        status: 401,
        body: { error: expect.objectContaining({ code: "E_UNAUTHENTICATED" }) },
      });
      expect(reachedRoute).toBe(false);
    } finally {
      await close(server);
    }
  });

  it("keeps JSON at 64 KiB and caps authenticated backups at 64 MiB", async () => {
    const server = createServer(handleHttp(new Hono(), undefined, { authorizeBackup: () => true }));
    const port = await listen(server);
    try {
      for (const [path, size] of [
        ["/api/v1/settings", 64 * 1024 + 1],
        ["/api/v1/backup/panel", MAX_BACKUP_BYTES + 1],
      ] as const) {
        const response = await upload(port, path, { "content-length": String(size) });
        expect(response.status).toBe(413);
        expect(response.body.error.code).toBe("E_PAYLOAD_TOO_LARGE");
      }
      const chunked = await upload(port, "/api/v1/settings", {}, [
        Buffer.alloc(32768),
        Buffer.alloc(32769),
      ]);
      expect(chunked.status).toBe(413);
      expect(chunked.body.error.code).toBe("E_PAYLOAD_TOO_LARGE");
    } finally {
      await close(server);
    }
  });

  it("streams file uploads and allows 2 MiB of file text in JSON", async () => {
    const app = new Hono();
    app.post("/api/v1/nodes/:id/fs/upload", async (c) => {
      let bytes = 0;
      for await (const chunk of c.req.raw.body ?? []) bytes += (chunk as Uint8Array).byteLength;
      return c.json({ bytes });
    });
    app.post("/api/v1/nodes/:id/fs/write", async (c) =>
      c.json({ length: ((await c.req.json()) as { content: string }).content.length }),
    );
    const server = createServer(handleHttp(app));
    const port = await listen(server);
    try {
      const big = Buffer.alloc(3 * 1024 * 1024, 1);
      const uploaded = await fetch(`http://127.0.0.1:${port}/api/v1/nodes/n1/fs/upload`, {
        method: "POST",
        body: big,
      });
      expect(await uploaded.json()).toEqual({ bytes: big.byteLength });
      const saved = await fetch(`http://127.0.0.1:${port}/api/v1/nodes/n1/fs/write`, {
        method: "POST",
        body: JSON.stringify({ content: "x".repeat(2 * 1024 * 1024) }),
      });
      expect(await saved.json()).toEqual({ length: 2 * 1024 * 1024 });
    } finally {
      await close(server);
    }
  });

  it("streams response bodies and cancels them when the client leaves", async () => {
    const app = new Hono();
    let pulls = 0;
    let cancelled: () => void = () => undefined;
    const gone = new Promise<void>((resolve) => (cancelled = resolve));
    app.get("/stream", () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(64 * 1024));
        },
        cancel() {
          cancelled();
        },
      });
      return new Response(body);
    });
    const server = createServer(handleHttp(app));
    const port = await listen(server);
    try {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port}/stream`, {
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      await reader?.read();
      controller.abort();
      await gone;
      // An endless body is only produced as fast as the client reads it.
      expect(pulls).toBeLessThan(200);
    } finally {
      await close(server);
    }
  });

  it("uses only the secure host cookie when HTTPS is enabled", () => {
    const plain = sessionCookie("plain-fixture", false);
    const secure = sessionCookie("secure-fixture", true);
    expect(sessionTokenFromCookie(plain, true)).toBeNull();
    expect(sessionTokenFromCookie(`${plain}; ${secure}`, true)).toBe("secure-fixture");
    expect(sessionTokenFromCookie(plain, false)).toBe("plain-fixture");
  });
});
