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

  it("uses only the secure host cookie when HTTPS is enabled", () => {
    const plain = sessionCookie("plain-fixture", false);
    const secure = sessionCookie("secure-fixture", true);
    expect(sessionTokenFromCookie(plain, true)).toBeNull();
    expect(sessionTokenFromCookie(`${plain}; ${secure}`, true)).toBe("secure-fixture");
    expect(sessionTokenFromCookie(plain, false)).toBe("plain-fixture");
  });
});
