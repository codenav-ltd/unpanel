// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  binaryKind,
  FS_UPLOAD_LIMIT,
  fsDownload,
  fsMethods,
  fsPath,
  fsUpload,
  httpStatusFor,
  MAX_BINARY_PAYLOAD_BYTES,
  streamWindow,
  type FsOperation,
  type MethodDef,
} from "@unpanel/protocol";
import { managesPanel, seesNode, type UserAccess } from "@unpanel/shared";
import type { AuditInput } from "../audit/log.ts";
import { HubCallError } from "../hub.ts";
import type { PanelStream, StreamCallbacks, StreamError } from "../stream-client.ts";

/** JSON bodies carry at most 2 MiB of file text; escaping can roughly double it. */
const JSON_BODY_LIMIT = 6 * 1024 * 1024;

type Status = 400 | 401 | 403 | 404 | 409 | 412 | 413 | 429 | 500 | 501 | 502 | 503 | 504;

class FilesHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: Status,
  ) {
    super(message);
  }
}

const fromHub = (error: unknown): FilesHttpError => {
  if (error instanceof FilesHttpError) return error;
  if (error instanceof HubCallError)
    return new FilesHttpError(error.code, error.message, error.status as Status);
  const stream = error as Partial<StreamError> | undefined;
  if (stream?.code && typeof stream.msg === "string")
    return new FilesHttpError(stream.code, stream.msg, httpStatusFor(stream.code) as Status);
  return new FilesHttpError("E_INTERNAL", "The file operation failed. Open Logs.", 500);
};

/**
 * `/api/v1/nodes/:id/fs/*`. Owners and admins only; contents and changes need a recent
 * identity confirmation and are audited. See modules/terminal-files.md §2.
 */
export function registerFilesApi(
  app: Hono,
  options: {
    user: (c: Context) => { id: string; username: string } | null;
    access: (userId: string) => UserAccess;
    /** Whether this request's session confirmed its identity recently (step-up). */
    elevated: (c: Context, userId: string) => boolean;
    audit: { record: (input: AuditInput) => void };
    ip: (c: Context) => string;
    call: <Params, Result>(
      nodeId: string,
      method: MethodDef<Params, Result>,
      params: Params,
    ) => Promise<Result>;
    openStream: (
      nodeId: string,
      request: { method: string; capability: string; params?: unknown; window: number },
      callbacks: StreamCallbacks,
    ) => Promise<PanelStream>;
  },
): void {
  /** The signed-in user when they may use files on this node, after step-up if `sudo`. */
  function authorize(c: Context, sudo: boolean): { id: string; username: string } {
    const user = options.user(c);
    if (!user) throw new FilesHttpError("E_UNAUTHENTICATED", "Sign in to continue.", 401);
    const access = options.access(user.id);
    if (!managesPanel(access) || !seesNode(access, c.req.param("id") ?? ""))
      throw new FilesHttpError(
        "E_FORBIDDEN",
        "Only owners and admins can use the file manager.",
        403,
      );
    if (sudo && !options.elevated(c, user.id))
      throw new FilesHttpError(
        "E_SUDO_REQUIRED",
        "Confirm your identity to read or change files.",
        403,
      );
    return user;
  }

  function record(
    c: Context,
    user: { username: string },
    action: string,
    target: string,
    error?: FilesHttpError,
    params?: Record<string, unknown>,
  ): void {
    options.audit.record({
      action,
      result: error ? "error" : "ok",
      actorKind: "user",
      actorId: user.username,
      nodeId: c.req.param("id") ?? "",
      target,
      ip: options.ip(c),
      ...(params ? { params } : {}),
      ...(error ? { errorCode: error.code } : {}),
    });
  }

  const reply = (c: Context, error: FilesHttpError): Response =>
    c.json({ error: { code: error.code, message: error.message } }, error.status);

  const audited = new Set<FsOperation>([
    "read",
    "write",
    "mkdir",
    "rename",
    "copy",
    "delete",
    "chmod",
    "chown",
  ]);

  for (const operation of Object.keys(fsMethods) as FsOperation[]) {
    const method = fsMethods[operation] as MethodDef<Record<string, unknown>, unknown>;
    const read = method.risk === "read";
    app.on(read ? "GET" : "POST", `/api/v1/nodes/:id/fs/${operation}`, async (c) => {
      let user: { id: string; username: string };
      try {
        user = authorize(c, operation !== "list" && operation !== "stat");
      } catch (error) {
        return reply(c, fromHub(error));
      }
      let body: unknown;
      if (read) body = c.req.query();
      else {
        if (Number(c.req.header("content-length") ?? 0) > JSON_BODY_LIMIT)
          return reply(
            c,
            new FilesHttpError("E_TOO_LARGE", "Files larger than 2 MiB cannot be edited.", 413),
          );
        body = await c.req.json().catch(() => null);
      }
      const parsed = method.params.safeParse(body);
      if (!parsed.success)
        return reply(
          c,
          new FilesHttpError(
            "E_INVALID_PARAMS",
            parsed.error.issues[0]?.message ?? "Check the path and try again.",
            400,
          ),
        );
      const params = parsed.data;
      const target =
        operation === "rename" || operation === "copy"
          ? `${String(params["from"])} → ${String(params["to"])}`
          : String(params["path"]);
      const details =
        operation === "chmod"
          ? { mode: Number(params["mode"]).toString(8), recursive: params["recursive"] }
          : operation === "chown"
            ? { owner: params["owner"], group: params["group"], recursive: params["recursive"] }
            : operation === "delete"
              ? { recursive: params["recursive"] }
              : undefined;
      try {
        const data = await options.call(c.req.param("id"), method, params);
        if (audited.has(operation)) record(c, user, `fs.${operation}`, target, undefined, details);
        return c.json({ data });
      } catch (error) {
        const failure = fromHub(error);
        if (audited.has(operation)) record(c, user, `fs.${operation}`, target, failure, details);
        return reply(c, failure);
      }
    });
  }

  app.post("/api/v1/nodes/:id/fs/upload", async (c) => {
    let user: { id: string; username: string };
    try {
      user = authorize(c, true);
    } catch (error) {
      return reply(c, fromHub(error));
    }
    // `check=1` comes first without a body: it confirms access (and step-up) before a large
    // file is sent, and tells the browser whether the name is taken.
    if (c.req.query("check") === "1") {
      const path = fsPath.safeParse(c.req.query("path"));
      if (!path.success)
        return reply(c, new FilesHttpError("E_INVALID_PARAMS", "Choose where to upload.", 400));
      try {
        const found = await options.call(c.req.param("id"), fsMethods.stat, { path: path.data });
        return c.json({ data: { exists: true, type: found.entry.type } });
      } catch (error) {
        const failure = fromHub(error);
        if (failure.code === "E_NOT_FOUND") return c.json({ data: { exists: false } });
        return reply(c, failure);
      }
    }
    const size = Number(c.req.header("content-length"));
    const params = fsUpload.params.safeParse({
      path: c.req.query("path"),
      size: Number.isInteger(size) ? size : -1,
      overwrite: c.req.query("overwrite") === "1",
    });
    if (!Number.isInteger(size) || size < 0)
      return reply(c, new FilesHttpError("E_INVALID_PARAMS", "The upload needs a length.", 400));
    if (size > FS_UPLOAD_LIMIT)
      return reply(
        c,
        new FilesHttpError("E_TOO_LARGE", "Files larger than 2 GiB cannot be uploaded.", 413),
      );
    if (!params.success)
      return reply(c, new FilesHttpError("E_INVALID_PARAMS", "Choose where to upload.", 400));
    const path = params.data.path;
    try {
      await relayUpload(c, params.data, size);
      record(c, user, "fs.upload", path, undefined, { size });
      return c.json({ data: { status: "ok" } });
    } catch (error) {
      const failure = fromHub(error);
      record(c, user, "fs.upload", path, failure, { size });
      return reply(c, failure);
    }
  });

  /** Pipes the request body into `fs.upload`, never faster than the agent writes. */
  async function relayUpload(
    c: Context,
    params: { path: string; size: number; overwrite: boolean },
    size: number,
  ): Promise<void> {
    let available = 0;
    let wake: (() => void) | null = null;
    let ended: { error?: StreamError } | null = null;
    let settle: (value: { error?: StreamError }) => void = () => undefined;
    const done = new Promise<{ error?: StreamError }>((resolve) => (settle = resolve));
    const stream = await options.openStream(
      c.req.param("id") ?? "",
      { method: fsUpload.name, capability: fsUpload.capability, params, window: 1024 },
      {
        data: () => undefined,
        credit(bytes) {
          available += bytes;
          wake?.();
        },
        close(error) {
          ended = error ? { error } : {};
          settle(ended);
          wake?.();
        },
      },
    );
    available = stream.window;
    const hash = createHash("sha256");
    let sent = 0;
    const reader = c.req.raw.body?.getReader();
    try {
      while (reader) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        for (let offset = 0; offset < value.byteLength;) {
          while (available === 0 && !ended) await new Promise<void>((resolve) => (wake = resolve));
          if (ended) throw (ended as { error?: StreamError }).error ?? unexpectedEnd();
          const piece = value.subarray(
            offset,
            offset + Math.min(available, MAX_BINARY_PAYLOAD_BYTES, value.byteLength - offset),
          );
          if (!stream.write(binaryKind.data, piece)) throw unexpectedEnd();
          hash.update(piece);
          available -= piece.byteLength;
          offset += piece.byteLength;
          sent += piece.byteLength;
        }
      }
    } catch (error) {
      stream.close();
      throw error instanceof FilesHttpError || (error as StreamError | undefined)?.code
        ? error
        : new FilesHttpError("E_INVALID_PARAMS", "The upload was interrupted.", 400);
    }
    if (sent !== size) {
      stream.close();
      throw new FilesHttpError("E_INVALID_PARAMS", "The upload was interrupted.", 400);
    }
    stream.write(
      binaryKind.ctrl,
      new TextEncoder().encode(JSON.stringify({ done: true, sha256: hash.digest("hex") })),
    );
    const result = await done;
    if (result.error) throw result.error;
  }

  app.get("/api/v1/nodes/:id/fs/download", async (c) => {
    let user: { id: string; username: string };
    try {
      user = authorize(c, true);
    } catch (error) {
      return reply(c, fromHub(error));
    }
    const params = fsDownload.params.safeParse({ path: c.req.query("path") });
    if (!params.success)
      return reply(c, new FilesHttpError("E_INVALID_PARAMS", "Choose what to download.", 400));
    const path = params.data.path;
    // `check=1` lets the browser confirm access (and step-up) before it starts a download it
    // cannot read errors from.
    if (c.req.query("check") === "1") {
      try {
        const found = await options.call(c.req.param("id"), fsMethods.stat, { path });
        return c.json({ data: { type: found.entry.type } });
      } catch (error) {
        return reply(c, fromHub(error));
      }
    }
    try {
      const response = await relayDownload(c, path);
      record(c, user, "fs.download", path);
      return response;
    } catch (error) {
      const failure = fromHub(error);
      record(c, user, "fs.download", path, failure);
      return reply(c, failure);
    }
  });

  /** Answers once the agent says what it is sending; the body then follows its credit. */
  async function relayDownload(c: Context, path: string): Promise<Response> {
    const queue: Uint8Array[] = [];
    let ended: { error?: StreamError } | null = null;
    let wake: (() => void) | null = null;
    let started: (start: unknown) => void = () => undefined;
    let failed: (error: unknown) => void = () => undefined;
    const start = new Promise<unknown>((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    const stream = await options.openStream(
      c.req.param("id") ?? "",
      {
        method: fsDownload.name,
        capability: fsDownload.capability,
        params: { path },
        window: streamWindow.file,
      },
      {
        data(kind, payload) {
          if (kind === binaryKind.ctrl) {
            try {
              started(JSON.parse(new TextDecoder().decode(payload)));
            } catch {
              started(null);
            }
            return;
          }
          queue.push(payload);
          wake?.();
        },
        credit: () => undefined,
        close(error) {
          ended = error ? { error } : {};
          if (error) failed(error);
          else started(null);
          wake?.();
        },
      },
    );
    const parsed = fsDownload.start.safeParse(await start);
    if (!parsed.success) {
      stream.close();
      throw new FilesHttpError(
        "E_EXTERNAL",
        "The agent's reply did not match this panel version. Update the agent and retry.",
        502,
      );
    }
    const info = parsed.data;
    const name = (path.split("/").pop() || "download") + (info.kind === "dir" ? ".tar.gz" : "");
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        while (queue.length === 0 && !ended) await new Promise<void>((resolve) => (wake = resolve));
        const chunk = queue.shift();
        if (chunk) {
          controller.enqueue(chunk);
          // Credit returns only once the browser has taken the bytes.
          stream.credit(chunk.byteLength);
          return;
        }
        const end = ended as { error?: StreamError } | null;
        if (end?.error) controller.error(new Error(end.error.msg));
        else controller.close();
      },
      cancel() {
        stream.close();
      },
    });
    const headers: Record<string, string> = {
      "content-type": info.kind === "dir" ? "application/gzip" : "application/octet-stream",
      "content-disposition": contentDisposition(name),
      "x-content-type-options": "nosniff",
    };
    if (info.kind === "file") headers["content-length"] = String(info.size);
    return new Response(body, { status: 200, headers });
  }
}

const unexpectedEnd = (): FilesHttpError =>
  new FilesHttpError("E_EXTERNAL", "The node stopped accepting the upload. Try again.", 502);

/** An attachment header that survives any file name. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
