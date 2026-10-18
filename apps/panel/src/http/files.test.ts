// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FsOperation } from "@unpanel/protocol";
import type { UserRole } from "@unpanel/shared";
import { fileStreams } from "../../../agent/src/file-streams.ts";
import { createFiles, filesPolicy } from "../../../agent/src/files.ts";
import { createStreamHost } from "../../../agent/src/stream-host.ts";
import type { AuditInput } from "../audit/log.ts";
import { HubCallError } from "../hub.ts";
import { createStreamClient } from "../stream-client.ts";
import { contentDisposition, registerFilesApi } from "./files.ts";

let root: string;
let role: UserRole;
let elevated: boolean;
let audit: AuditInput[];
let app: Hono;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "unpanel-files-api-")));
  mkdirSync(join(root, "secret"));
  role = "owner";
  elevated = true;
  audit = [];
  const policy = filesPolicy({ UNPANEL_FILES_DENY: join(root, "secret") });
  const files = createFiles({ policy });
  // The agent's real file methods and streams, joined to the panel in memory.
  const host = createStreamHost({
    methods: new Map(fileStreams(files.guard)),
    send: (frame) => queueMicrotask(() => client.handleText(frame)),
    sendBinary: (bytes) => queueMicrotask(() => client.handleBinary(bytes)),
    buffered: () => 0,
  });
  const client = createStreamClient({
    send: (frame) => queueMicrotask(() => host.handleText(frame)),
    sendBinary: (bytes) => queueMicrotask(() => host.handleBinary(bytes)),
  });
  app = new Hono();
  registerFilesApi(app, {
    user: () => ({ id: "u1", username: "alice" }),
    access: () => ({ role, nodeIds: null, locked: false }),
    elevated: () => elevated,
    audit: { record: (input) => audit.push(input) },
    ip: () => "203.0.113.9",
    call: async (_nodeId, method, params) => {
      try {
        return method.result.parse(
          await files.run(method.name.slice(3) as FsOperation, params),
        ) as never;
      } catch (error) {
        const failure = error as { code: "E_NOT_FOUND"; message: string };
        throw new HubCallError(failure.code, failure.message);
      }
    },
    openStream: (_nodeId, request, callbacks) =>
      client.open(request, callbacks).catch((error: { code: "E_NOT_FOUND"; msg: string }) => {
        throw new HubCallError(error.code, error.msg);
      }),
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const url = (operation: string, query: Record<string, string> = {}): string =>
  `/api/v1/nodes/n1/fs/${operation}?${new URLSearchParams(query).toString()}`;
const post = async (operation: string, body: unknown): Promise<Response> =>
  app.request(url(operation), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function upload(path: string, bytes: Uint8Array, query: Record<string, string> = {}) {
  return app.request(url("upload", { path, ...query }), {
    method: "POST",
    headers: { "content-length": String(bytes.byteLength) },
    body: new Blob([bytes]).stream(),
    duplex: "half",
  } as RequestInit);
}

describe("files API", () => {
  it("is for owners and admins only", async () => {
    for (const denied of ["operator", "viewer"] as const) {
      role = denied;
      const response = await app.request(url("list", { path: root }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "E_FORBIDDEN" } });
    }
  });

  it("lists without step-up but needs it for contents and changes", async () => {
    elevated = false;
    writeFileSync(join(root, "a.txt"), "a");
    const listed = await app.request(url("list", { path: root }));
    expect(listed.status).toBe(200);
    const names = ((await listed.json()) as { data: { entries: { name: string }[] } }).data.entries
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual(["a.txt", "secret"]);
    for (const response of [
      await app.request(url("read", { path: join(root, "a.txt") })),
      await post("mkdir", { path: join(root, "d") }),
      await app.request(url("download", { path: join(root, "a.txt") })),
      await upload(join(root, "b"), new Uint8Array(1)),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "E_SUDO_REQUIRED" } });
    }
    expect(audit).toEqual([]);
  });

  it("saves with a conflict check and audits it", async () => {
    const path = join(root, "app.conf");
    writeFileSync(path, "old");
    const read = (await (await app.request(url("read", { path }))).json()) as {
      data: { content: string; mtime: number; size: number };
    };
    expect(read.data.content).toBe("old");
    const saved = await post("write", {
      path,
      content: "new",
      expectedMtime: read.data.mtime,
      expectedSize: read.data.size,
    });
    expect(saved.status).toBe(200);
    const stale = await post("write", {
      path,
      content: "newer",
      expectedMtime: read.data.mtime,
      expectedSize: read.data.size,
    });
    expect(stale.status).toBe(409);
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(audit.map((entry) => [entry.action, entry.result, entry.target])).toEqual([
      ["fs.read", "ok", path],
      ["fs.write", "ok", path],
      ["fs.write", "error", path],
    ]);
    expect(audit[0]).toMatchObject({ actorId: "alice", nodeId: "n1", ip: "203.0.113.9" });
  });

  it("maps policy refusals and records what was asked", async () => {
    const response = await post("delete", { path: join(root, "secret"), recursive: true });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "E_POLICY_DENIED" } });
    expect(audit[0]).toMatchObject({
      action: "fs.delete",
      result: "error",
      errorCode: "E_POLICY_DENIED",
      params: { recursive: true },
    });
  });

  it("audits packing and unpacking with what was packed", async () => {
    mkdirSync(join(root, "site"));
    writeFileSync(join(root, "site", "index.html"), "hi");
    const to = join(root, "site.zip");
    expect((await post("archive", { paths: [join(root, "site")], to, format: "zip" })).status).toBe(
      200,
    );
    const unpacked = await post("extract", { path: to, into: root });
    expect(await unpacked.json()).toMatchObject({ data: { path: join(root, "site-2") } });
    expect(audit.map((entry) => [entry.action, entry.target, entry.params])).toEqual([
      ["fs.archive", to, { format: "zip", items: 1, paths: [join(root, "site")] }],
      ["fs.extract", `${to} → ${root}`, undefined],
    ]);
  });

  it("checks an upload target before the body is sent", async () => {
    writeFileSync(join(root, "taken"), "");
    const check = async (name: string) =>
      (
        await app.request(url("upload", { path: join(root, name), check: "1" }), {
          method: "POST",
        })
      ).json();
    expect(await check("taken")).toEqual({ data: { exists: true, type: "file" } });
    expect(await check("free")).toEqual({ data: { exists: false } });
  });

  it("streams an upload into place", async () => {
    const bytes = new Uint8Array(6 * 1024 * 1024).map((_, i) => (i * 7) % 256);
    const response = await upload(join(root, "image.bin"), bytes);
    expect(response.status).toBe(200);
    expect(readFileSync(join(root, "image.bin")).equals(Buffer.from(bytes))).toBe(true);
    expect(audit).toMatchObject([
      { action: "fs.upload", result: "ok", params: { size: bytes.byteLength } },
    ]);
  });

  it("drops an upload that ends early", async () => {
    const response = await app.request(url("upload", { path: join(root, "short.bin") }), {
      method: "POST",
      headers: { "content-length": "100" },
      body: new Blob([new Uint8Array(40)]).stream(),
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readdirSync(root).sort()).toEqual(["secret"]);
  });

  it("refuses to replace a file unless asked", async () => {
    writeFileSync(join(root, "a"), "old");
    expect((await upload(join(root, "a"), new Uint8Array([1]))).status).toBe(409);
    expect((await upload(join(root, "a"), new Uint8Array([1]), { overwrite: "1" })).status).toBe(
      200,
    );
    expect(statSync(join(root, "a")).size).toBe(1);
  });

  it("streams a download with its length and name", async () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 3, 0x62);
    writeFileSync(join(root, "réport.log"), bytes);
    const response = await app.request(url("download", { path: join(root, "réport.log") }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(response.headers.get("content-disposition")).toBe(contentDisposition("réport.log"));
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    expect(audit).toMatchObject([{ action: "fs.download", result: "ok" }]);
  });

  it("checks a download before the browser starts it", async () => {
    writeFileSync(join(root, "a.txt"), "a");
    const ok = await app.request(url("download", { path: join(root, "a.txt"), check: "1" }));
    expect(await ok.json()).toEqual({ data: { type: "file" } });
    const denied = await app.request(url("download", { path: join(root, "secret"), check: "1" }));
    expect(denied.status).toBe(403);
    expect(audit).toEqual([]);
  });

  it("answers a refused download as JSON", async () => {
    const response = await app.request(url("download", { path: join(root, "secret") }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "E_POLICY_DENIED" } });
  });
});

describe("contentDisposition", () => {
  it("keeps an ASCII fallback and the exact UTF-8 name", () => {
    expect(contentDisposition('a"b\\c 文件.txt')).toBe(
      `attachment; filename="a_b_c __.txt"; filename*=UTF-8''a%22b%5Cc%20%E6%96%87%E4%BB%B6.txt`,
    );
  });
});
